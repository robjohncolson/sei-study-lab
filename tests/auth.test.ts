import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  AuthRateLimiter, buildSessionCookie, hashPassword, hashSessionToken, newSessionToken,
  normalizeUsername, readSessionCookie, sessionCookieSettings, setupCodeMatches,
  validatePassword, validateSessionSecret, verifyPassword,
} from '../apps/server/src/auth/core.js';
import { AuthService, isPublicAuthRoute, type AuthStore } from '../apps/server/src/auth/service.js';
import { readHostedConfig } from '../apps/server/src/hosted-config.js';
import { withAuthTransaction } from '../apps/server/src/auth/postgres-auth-store.js';
import type { Pool, PoolClient } from 'pg';

const secret = () => randomBytes(32).toString('base64url');
const local = new Set(['http://127.0.0.1:4317', 'http://localhost:5173']);
const hosted = new Set(['https://study.example.test']);

describe('password credentials', () => {
  it('uses the required scrypt parameters, random salts and constant-time key verification', async () => {
    const password = secret(), hash = await hashPassword(password), another = await hashPassword(password);
    // Assert booleans so failures never print credentials or stored hashes.
    expect(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(hash)).toBe(true);
    expect(hash !== another).toBe(true);
    expect(await verifyPassword(password, hash)).toBe(true);
    expect(await verifyPassword(secret(), hash)).toBe(false);
  });
  it('takes the dummy verification path for unknown and malformed credentials', async () => {
    const password = secret();
    expect(await verifyPassword(password, null)).toBe(false);
    expect(await verifyPassword(password)).toBe(false);
    expect(await verifyPassword(password, 'malformed')).toBe(false);
    expect(await verifyPassword(password, `${await hashPassword(password)}\n`)).toBe(false);
  });
  it('normalizes usernames without accepting whitespace, Unicode lookalikes or invalid boundaries', () => {
    expect(normalizeUsername('Owner.ONE_2-x')).toBe('owner.one_2-x');
    for (const value of [null, {}, '', 'ab', '-owner', '_owner', '.owner', 'a'.repeat(33), 'owner\n', ' owner', 'owner ', 'ownér', 'own/er']) {
      expect(() => normalizeUsername(value)).toThrow();
    }
  });
  it('bounds password characters and UTF-8 bytes without trimming or changing the answer', () => {
    const password = ` ${secret()} `;
    expect(validatePassword(password) === password).toBe(true);
    for (const value of [null, {}, '', 'a'.repeat(9), 'a'.repeat(201), ' '.repeat(20), '\t'.repeat(20), '😀'.repeat(201)]) {
      expect(() => validatePassword(value)).toThrow();
    }
    expect(validatePassword('x'.repeat(200)).length).toBe(200);
  });
});

describe('session tokens and cookies', () => {
  it('stores a keyed SHA256 digest, with independent random tokens', () => {
    const key = secret(), token = newSessionToken(), hash = hashSessionToken(key, token);
    expect(/^[A-Za-z0-9_-]{43}$/.test(token)).toBe(true);
    expect(/^[a-f0-9]{64}$/.test(hash)).toBe(true);
    expect(hash === createHmac('sha256', key).update(token).digest('hex')).toBe(true);
    expect(hash !== hashSessionToken(secret(), token)).toBe(true);
    expect(token !== newSessionToken()).toBe(true);
  });
  it('uses a secure host cookie except when every origin is explicitly HTTP loopback', () => {
    const token = newSessionToken();
    expect(sessionCookieSettings(hosted)).toEqual({ name: '__Host-sei_session', secure: true });
    expect(sessionCookieSettings(local)).toEqual({ name: 'sei_session', secure: false });
    for (const origins of [new Set<string>(), new Set([...local, ...hosted]), new Set(['http://localhost.example.test']), new Set(['http://127.0.0.2'])]) {
      expect(sessionCookieSettings(origins).secure).toBe(true);
    }
    const cookie = buildSessionCookie(hosted, token);
    expect(cookie.startsWith('__Host-sei_session=')).toBe(true);
    expect(cookie.endsWith('; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000')).toBe(true);
    expect(buildSessionCookie(local, token).includes('Secure')).toBe(false);
    expect(readSessionCookie(hosted, cookie) === token).toBe(true);
    expect(readSessionCookie(local, cookie) === null).toBe(true);
    expect(readSessionCookie(hosted, `${cookie}; ${cookie}`) === null).toBe(true);
    expect(buildSessionCookie(hosted, null)).toBe('__Host-sei_session=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0');
  });
  it('compares setup codes without exposing values or differing byte lengths', () => {
    const key = secret(), code = secret();
    expect(setupCodeMatches(key, code, code)).toBe(true);
    expect(setupCodeMatches(key, undefined, code)).toBe(false);
    expect(setupCodeMatches(key, code.slice(1), code)).toBe(false);
    expect(setupCodeMatches(key, secret(), code)).toBe(false);
  });
});

describe('configuration and throttling', () => {
  const environment = (): NodeJS.ProcessEnv => ({ HOSTED_AUTH_MODE: 'password',
    PUBLIC_OWNER_ID: randomUUID(), SEI_SESSION_SECRET: secret(),
    SEI_DATABASE_URL: 'postgresql://sei_app@127.0.0.1/synthetic',
    APP_ORIGINS: [...local].join(','), APP_HOSTS: '127.0.0.1:4317,localhost:5173' });
  it('requires the existing owner ID, defaults signup closed, and never requires a JWT project', () => {
    const env = environment(), config = readHostedConfig(env);
    expect(config.authMode).toBe('password');
    expect(config.ownerUserId).toBe(env.PUBLIC_OWNER_ID);
    expect(config.authMode === 'password' && config.allowSignup === false).toBe(true);
    expect(() => readHostedConfig({ ...env, PUBLIC_OWNER_ID: undefined })).toThrow('PUBLIC_OWNER_ID');
    expect(readHostedConfig({ ...env, AUTH_ALLOW_SIGNUP: 'true' })).toHaveProperty('allowSignup', true);
  });
  it('names only the setting in new auth configuration errors', () => {
    for (const [name, value] of [
      ['SEI_SESSION_SECRET', undefined], ['SEI_SESSION_SECRET', secret().slice(0, 31)],
      ['SEI_SESSION_SECRET', `${secret()}\n`], ['SEI_SESSION_SECRET', `${secret()}=`],
      ['SEI_SESSION_SECRET', 'a'.repeat(33)],
      ['AUTH_ALLOW_SIGNUP', 'TRUE'], ['AUTH_ALLOW_SIGNUP', 'false '],
      ['AUTH_SETUP_CODE', ''], ['AUTH_SETUP_CODE', ' '.repeat(32)],
    ]) {
      let message = '';
      try { readHostedConfig({ ...environment(), [name!]: value }); } catch (error) { message = (error as Error).message; }
      expect(message).toBe(name);
    }
    expect(validateSessionSecret(randomBytes(32).toString('hex')).length).toBe(64);
  });
  it('limits both an IP and a normalized username, refills, and bounds memory', () => {
    const limiter = new AuthRateLimiter();
    for (let i = 0; i < 10; i++) expect(limiter.take('ip-one', 'owner', 0)).toBe(true);
    expect(limiter.take('ip-one', 'other', 0)).toBe(false);
    expect(limiter.take('ip-two', 'owner', 0)).toBe(false);
    expect(limiter.take('ip-two', 'other', 0)).toBe(true);
    expect(limiter.take('ip-one', 'owner', 60_000)).toBe(true);
    const bounded = new AuthRateLimiter(10, 60_000, 2);
    expect(bounded.take('one', 'one', 0)).toBe(true);
    expect(bounded.take('two', 'two', 0)).toBe(false);
    expect(bounded.take('two', 'two', 60_000)).toBe(true);
  });
});

describe('auth boundary', () => {
  it('keeps a narrow public allowlist; identity, all study work and unknown API routes require a session', () => {
    for (const path of ['/api/catalog', '/api/health', '/api/anki.tsv', '/api/session', '/api/auth/login']) expect(isPublicAuthRoute(path)).toBe(true);
    for (const path of ['/api/state', '/api/identity', '/api/native-flashcards', '/api/export', '/api/import', '/api/handoff', '/api/proposals/approve', '/api/ai-feedback/status', '/api/future-route']) expect(isPublicAuthRoute(path)).toBe(false);
  });
  it('returns the identical safe failure for unknown, incorrect and locked credentials', async () => {
    const password = secret(), passwordHash = await hashPassword(password);
    for (const record of [null, { ownerId: randomUUID(), passwordHash, locked: false }, { ownerId: randomUUID(), passwordHash, locked: true }]) {
      const store = { loginLookup: async () => record, loginResult: async () => {}, createSession: vi.fn() } as unknown as AuthStore;
      const auth = new AuthService(store, { sessionSecret: secret(), firstOwner: randomUUID(), allowSignup: false, origins: local });
      await expect(auth.login({ username: 'owner', password: record?.locked ? password : secret() }, 'ip')).rejects.toMatchObject({ statusCode: 401, message: 'Invalid username or password' });
      expect(store.createSession).not.toHaveBeenCalled();
    }
  });
  it('clears owner claims inside a short auth transaction and rolls back safely', async () => {
    const query = vi.fn(async (_sql: string) => ({ rows: [{ role: 'sei_app' }] })), release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: async () => client } as unknown as Pool;
    await withAuthTransaction(pool, async () => undefined);
    expect(query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', "SELECT current_user AS role, pg_catalog.set_config('request.jwt.claims', '{}', true), pg_catalog.set_config('request.jwt.claim.sub', '', true)", 'COMMIT']);
    expect(release).toHaveBeenCalledWith(false);
    query.mockClear();
    await expect(withAuthTransaction(pool, async () => { throw new Error('test failure'); })).rejects.toThrow('test failure');
    expect(query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  });
});
