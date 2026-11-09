import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CatalogSchema } from '../../../packages/shared/src/index.js';
import content from '../../../content/catalog.json' with { type: 'json' };
import { createHostedSeiServer } from '../src/hosted-app.js';
import { readHostedConfig } from '../src/hosted-config.js';
import { PostgresAiStorage } from '../src/ai/postgres-ai-storage.js';
import { PostgresNativeStore } from '../src/postgres/native-store.js';
import { PostgresStudyStore } from '../src/postgres/study-store.js';
import { withOwnerTransaction } from '../src/postgres/transaction.js';
import { createPostgresHarness, type PostgresHarness } from './harness.js';

const catalog = CatalogSchema.parse(content);
const host = 'synthetic-accounts.example';
const origin = `https://${host}`;
const t0 = Date.parse('2026-11-09T12:00:00Z');
// Synthetic credentials are generated only in memory; assertions never print them.
const credential = () => randomBytes(24).toString('base64url');
const cookieFrom = (response: { headers: Record<string, unknown> }) => {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header.find(item => String(item).startsWith('__Host-sei_session=')) : header;
  if (typeof value !== 'string') throw new Error('Expected an auth cookie');
  return value.split(';')[0];
};

describe('password authentication on disposable real Postgres', () => {
  let harness: PostgresHarness;
  const apps: FastifyInstance[] = [];
  beforeAll(async () => { harness = await createPostgresHarness(); });
  beforeEach(async () => {
    await harness.database.query('DELETE FROM sei.auth_sessions; DELETE FROM sei.accounts');
  });
  afterAll(async () => {
    await Promise.all(apps.map(app => app.close()));
    if (harness) await harness.dispose();
  });

  async function setup(extra: NodeJS.ProcessEnv = {}, owner = randomUUID()) {
    let now = t0;
    const config = readHostedConfig({ STORAGE_MODE: 'postgres', HOSTED_AUTH_MODE: 'password', PUBLIC_OWNER_ID: owner,
      SEI_DATABASE_URL: harness.appUrl, APP_ORIGINS: origin, APP_HOSTS: host, SEI_SESSION_SECRET: credential(), ...extra });
    const clock = () => new Date(now);
    const app = await createHostedSeiServer({ config, pool: harness.pool, catalog, clock, ai: { env: {} } });
    apps.push(app);
    const session = await app.inject({ url: '/api/session', headers: { host } });
    expect(session.statusCode).toBe(200);
    const headers = { host, origin, 'x-csrf-token': session.json().csrfToken as string };
    const get = (url: string, cookie?: string) => app.inject({ url, headers: { ...headers, ...(cookie ? { cookie } : {}) } });
    const post = (url: string, payload: object = {}, cookie?: string) => app.inject({ method: 'POST', url,
      headers: { ...headers, ...(cookie ? { cookie } : {}) }, payload });
    return { app, owner, clock, headers, get, post, advance: (milliseconds: number) => { now += milliseconds; } };
  }

  async function seed(owner: string, clock: () => Date) {
    return withOwnerTransaction(harness.pool, { sub: owner, role: 'authenticated' }, async client => {
      const store = new PostgresStudyStore(client, owner, catalog, clock);
      const task = catalog.tasks.find(item => item.kind === 'writing')!;
      const mentor = catalog.mentorTexts.find(item => item.id === task.mentorTextId)!;
      const saved = await store.submit({ taskId: task.id, taskVersion: task.version, hintCount: 0, assistance: [],
        answer: { mentorTextId: mentor.id, mentorTextVersion: mentor.version, mentorTextHash: mentor.sha256,
          rubricVersionId: task.rubricVersionId,
          parts: Object.fromEntries(task.parts!.map(part => [part.id, 'Synthetic retained study explanation.'])) } }, 'synthetic-account');
      await new PostgresNativeStore(client, owner, { cards: catalog.cards.slice(0, 1) }, clock).initialize();
      return saved;
    });
  }

  it('gates every study route while leaving session, catalog, Anki and health public', async () => {
    const { get, post } = await setup();
    expect((await get('/api/session')).json()).toMatchObject({ storageMode: 'postgres', authMode: 'password',
      signedIn: false, username: null, signupOpen: true, setupCodeRequired: false });
    for (const url of ['/api/catalog', '/api/anki.tsv', '/api/health']) expect((await get(url)).statusCode).toBe(200);
    for (const url of ['/api/state', '/api/native-flashcards', '/api/native-flashcards/history',
      '/api/identity', '/api/drafts/synthetic', '/api/export', '/api/ai-feedback/status']) {
      const response = await get(url);
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Sign in required' });
    }
    for (const url of ['/api/attempts', '/api/native-flashcards/initialize', '/api/native-flashcards/reviews',
      '/api/native-flashcards/controls', '/api/import', '/api/import/preview', '/api/handoff',
      '/api/proposals/preview', '/api/proposals/approve', '/api/ai-feedback',
      '/api/ai-feedback/preview', '/api/ai-feedback/approve']) expect((await post(url)).statusCode).toBe(401);
  });

  it('gives the first account the existing owner history without copying it and closes sign-up by default', async () => {
    const { get, post, owner, clock } = await setup();
    const saved = await seed(owner, clock);
    const password = credential();
    const signup = await post('/api/auth/signup', { username: 'FIRST.Owner', password });
    expect(signup.statusCode).toBe(200);
    const cookie = cookieFrom(signup);
    expect(String(signup.headers['set-cookie']).includes('HttpOnly')).toBe(true);
    expect(String(signup.headers['set-cookie']).includes('Secure')).toBe(true);
    expect(String(signup.headers['set-cookie']).includes('SameSite=Lax')).toBe(true);
    expect((await get('/api/identity', cookie)).json().ownerId).toBe(owner);
    expect((await get('/api/session', cookie)).json()).toMatchObject({ signedIn: true, username: 'first.owner', signupOpen: false });
    const state = (await get('/api/state', cookie)).json();
    expect(state.attempts).toHaveLength(1);
    expect(state.attempts[0].id).toBe(saved.attempt.id);
    expect((await get('/api/native-flashcards/history', cookie)).json()).toHaveLength(1);
    expect((await post('/api/auth/signup', { username: 'second.owner', password: credential() })).statusCode).toBe(403);
    const stored = await harness.database.query('SELECT owner_id, username, password_hash FROM sei.accounts');
    expect(stored.rowCount).toBe(1);
    expect(stored.rows[0].owner_id).toBe(owner);
    expect(stored.rows[0].password_hash.startsWith('scrypt$')).toBe(true);
    const rawToken = cookie.slice(cookie.indexOf('=') + 1);
    const tokens = await harness.database.query('SELECT token_hash FROM sei.auth_sessions');
    expect(tokens.rows.every(row => /^[0-9a-f]{64}$/.test(row.token_hash) && row.token_hash !== rawToken)).toBe(true);
    expect(JSON.stringify(stored.rows).includes(password)).toBe(false);
    const login = await post('/api/auth/login', { username: 'FIRST.OWNER', password });
    expect(login.statusCode).toBe(200);
    expect((await get('/api/identity', cookieFrom(login))).json().ownerId).toBe(owner);
  });

  it('allows later accounts only when configured and isolates history, flashcards and AI requests both ways', async () => {
    const { get, post, owner, clock } = await setup({ AUTH_ALLOW_SIGNUP: 'true' });
    const firstSaved = await seed(owner, clock);
    const first = await post('/api/auth/signup', { username: 'first.owner', password: credential() });
    const firstCookie = cookieFrom(first);
    const second = await post('/api/auth/signup', { username: 'second.owner', password: credential() });
    expect(second.statusCode).toBe(200);
    const secondCookie = cookieFrom(second);
    const secondOwner = (await get('/api/identity', secondCookie)).json().ownerId as string;
    expect(secondOwner).not.toBe(owner);
    expect(secondOwner).toMatch(/^[0-9a-f-]{36}$/);
    expect((await get('/api/state', secondCookie)).json()).toMatchObject({ attempts: [], judgments: [], evidenceEvents: [], drafts: [] });
    expect((await get('/api/native-flashcards/history', secondCookie)).json()).toEqual([]);
    const secondSaved = await seed(secondOwner, clock);
    expect((await get('/api/state', firstCookie)).json().attempts.map((item: { id: string }) => item.id)).toEqual([firstSaved.attempt.id]);
    expect((await get('/api/state', secondCookie)).json().attempts.map((item: { id: string }) => item.id)).toEqual([secondSaved.attempt.id]);
    const histories = await Promise.all([firstCookie, secondCookie].map(cookie => get('/api/native-flashcards/history', cookie)));
    expect(histories[0].json()).toHaveLength(1);
    expect(histories[1].json()).toHaveLength(1);
    expect(histories[0].json()[0].id).not.toBe(histories[1].json()[0].id);
    for (const [accountOwner, saved, foreignCookie, foreignOwner] of [
      [owner, firstSaved, secondCookie, secondOwner], [secondOwner, secondSaved, firstCookie, owner],
    ] as const) {
      const storage = new PostgresAiStorage(harness.pool, { sub: accountOwner, role: 'authenticated' }, catalog, clock);
      const id = randomUUID();
      await storage.reserve('2026-11-09', 100, 1000, 10);
      await storage.finish({ day: '2026-11-09', reservedMicroUsd: 100, costMicroUsd: 0, inputTokens: 0, outputTokens: 0,
        request: { id, attemptId: saved.attempt.id, previewSha256: '0'.repeat(64), model: 'deepseek-flash', status: 'failed',
          proposal: null, costMicroUsd: 0, createdAt: clock().toISOString() } });
      expect(await storage.usage('2026-11-09')).toMatchObject({ requests: 1, reservedMicroUsd: 0, spentMicroUsd: 0 });
      const foreignStorage = new PostgresAiStorage(harness.pool, { sub: foreignOwner, role: 'authenticated' }, catalog, clock);
      expect((await foreignStorage.usage('2026-11-09')).requests).toBe(foreignOwner === owner ? 1 : 0);
      expect((await post('/api/ai-feedback/preview', { attemptId: saved.attempt.id }, foreignCookie)).statusCode).toBe(404);
      expect((await post('/api/ai-feedback/approve', { requestId: id, confirm: true }, foreignCookie)).statusCode).toBe(404);
      const rows = await withOwnerTransaction(harness.pool, { sub: foreignOwner, role: 'authenticated' }, client =>
        client.query('SELECT id FROM sei.ai_feedback_requests WHERE id=$1', [id]));
      expect(rows.rows).toEqual([]);
    }
    const closed = await setup({ AUTH_ALLOW_SIGNUP: 'false' }, owner);
    expect((await closed.post('/api/auth/signup', { username: 'third.owner', password: credential() })).statusCode).toBe(403);
  });

  it('uses the same generic failure for unknown, incorrect and locked accounts and unlocks after 15 minutes', async () => {
    const { post, advance } = await setup();
    const password = credential();
    expect((await post('/api/auth/signup', { username: 'owner', password })).statusCode).toBe(200);
    advance(60_001);
    const unknown = await post('/api/auth/login', { username: 'unknown', password });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual({ error: 'Invalid username or password' });
    for (let failure = 0; failure < 10; failure++) {
      advance(60_001);
      const response = await post('/api/auth/login', { username: 'owner', password: credential() });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual(unknown.json());
    }
    advance(60_001);
    const locked = await post('/api/auth/login', { username: 'owner', password });
    expect(locked.statusCode).toBe(401);
    expect(locked.json()).toEqual(unknown.json());
    advance(15 * 60_000);
    expect((await post('/api/auth/login', { username: 'owner', password })).statusCode).toBe(200);
    const row = (await harness.database.query('SELECT failed_logins, locked_until, last_login_at FROM sei.accounts')).rows[0];
    expect(row.failed_logins).toBe(0);
    expect(row.locked_until).toBeNull();
    expect(row.last_login_at).toBeInstanceOf(Date);
  });

  it('revokes logout cookies, expires sessions after 30 days and clears the cookie', async () => {
    const { post, get, advance } = await setup();
    const password = credential();
    const signup = await post('/api/auth/signup', { username: 'owner', password });
    const cookie = cookieFrom(signup);
    const logout = await post('/api/auth/logout', {}, cookie);
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers['set-cookie']).includes('Max-Age=0')).toBe(true);
    expect((await get('/api/state', cookie)).statusCode).toBe(401);
    expect((await get('/api/session', cookie)).json()).toMatchObject({ signedIn: false, username: null });
    const login = await post('/api/auth/login', { username: 'owner', password });
    const renewed = cookieFrom(login);
    expect((await get('/api/state', renewed)).statusCode).toBe(200);
    advance(30 * 24 * 60 * 60_000);
    expect((await get('/api/state', renewed)).statusCode).toBe(401);
  });

  it('requires the setup code, rejects invalid inputs, and treats duplicate usernames case-insensitively', async () => {
    const setupCode = credential();
    const { post, get } = await setup({ AUTH_SETUP_CODE: setupCode, AUTH_ALLOW_SIGNUP: 'true' });
    expect((await get('/api/session')).json().setupCodeRequired).toBe(true);
    for (const code of [undefined, credential()]) {
      expect((await post('/api/auth/signup', { username: 'owner', password: credential(), setupCode: code })).statusCode).toBe(403);
    }
    for (const payload of [{ username: '!invalid', password: credential(), setupCode },
      { username: 'owner', password: '', setupCode }, { username: 'owner', password: ' '.repeat(10), setupCode }]) {
      expect((await post('/api/auth/signup', payload)).statusCode).toBe(400);
    }
    expect((await post('/api/auth/signup', { username: 'Owner', password: credential(), setupCode })).statusCode).toBe(200);
    expect((await post('/api/auth/signup', { username: 'OWNER', password: credential(), setupCode })).statusCode).toBe(409);
  });

  it('retains Host, Origin and CSRF checks for all auth writes', async () => {
    const { app, headers } = await setup();
    for (const path of ['signup', 'login', 'logout']) {
      for (const rejected of [{ ...headers, host: 'untrusted.example' }, { ...headers, origin: 'https://untrusted.example' },
        { host, 'x-csrf-token': headers['x-csrf-token'] }, { host, origin }, { ...headers, 'x-csrf-token': 'invalid' }]) {
        expect((await app.inject({ method: 'POST', url: `/api/auth/${path}`, headers: rejected,
          payload: { username: 'owner', password: credential() } })).statusCode).toBe(403);
      }
    }
  });

  it('serializes competing first registrations so only one inherits PUBLIC_OWNER_ID', async () => {
    const { post, owner } = await setup();
    const responses = await Promise.all(['first', 'second'].map(username => post('/api/auth/signup', { username, password: credential() })));
    expect(responses.map(response => response.statusCode).sort()).toEqual([200, 403]);
    expect((await harness.database.query('SELECT owner_id FROM sei.accounts')).rows).toEqual([{ owner_id: owner }]);
  });

  it('forces RLS, grants only function execution, and denies direct auth-table access even with claims', async () => {
    const { owner, post } = await setup();
    await post('/api/auth/signup', { username: 'owner', password: credential() });
    for (const table of ['accounts', 'auth_sessions']) {
      expect((await harness.database.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_catalog.pg_class WHERE oid=$1::regclass', [`sei.${table}`])).rows[0])
        .toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      for (const sql of [`SELECT * FROM sei.${table}`, `INSERT INTO sei.${table} DEFAULT VALUES`]) {
        await expect(harness.pool.query(sql)).rejects.toMatchObject({ code: '42501' });
        await expect(withOwnerTransaction(harness.pool, { sub: owner, role: 'authenticated' }, client => client.query(sql)))
          .rejects.toMatchObject({ code: '42501' });
      }
      const grants = await harness.database.query(`SELECT COALESCE(r.rolname, 'PUBLIC') AS role
        FROM pg_catalog.pg_class c CROSS JOIN LATERAL pg_catalog.aclexplode(c.relacl) acl
        LEFT JOIN pg_catalog.pg_roles r ON r.oid=acl.grantee WHERE c.oid=$1::regclass`, [`sei.${table}`]);
      expect(grants.rows.some(row => ['PUBLIC', 'sei_app', 'anon', 'authenticated'].includes(row.role))).toBe(false);
      const policy = await harness.database.query(`SELECT policyname, roles, cmd, qual, with_check FROM pg_catalog.pg_policies
        WHERE schemaname='sei' AND tablename=$1`, [table]);
      expect(policy.rows).toHaveLength(1);
      expect(policy.rows[0]).toMatchObject({ policyname: 'sei_auth_definer', cmd: 'ALL', qual: 'true', with_check: 'true' });
      expect(policy.rows[0].roles).toEqual([(await harness.database.query('SELECT current_user')).rows[0].current_user]);
    }
    const functions = await harness.database.query(`SELECT p.proname, p.prosecdef, p.proconfig,
      pg_catalog.has_function_privilege('sei_app', p.oid, 'EXECUTE') AS executable
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='sei' AND p.proname LIKE 'auth_%'`);
    expect(functions.rows).toHaveLength(7);
    for (const row of functions.rows) expect(row).toMatchObject({ prosecdef: true, proconfig: ['search_path=pg_catalog'], executable: true });
    const publicFunctionGrants = await harness.database.query(`SELECT p.proname FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) acl LEFT JOIN pg_catalog.pg_roles r ON r.oid=acl.grantee
      WHERE n.nspname='sei' AND p.proname LIKE 'auth_%'
        AND (acl.grantee=0 OR r.rolname IN ('anon', 'authenticated'))`);
    expect(publicFunctionGrants.rows).toEqual([]);
  });
});
