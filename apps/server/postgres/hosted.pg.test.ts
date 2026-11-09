import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Pool } from 'pg';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Catalog } from '../../../packages/shared/src/index.js';
import type { NativeControlInput, NativeQueueItem, NativeQueueResponse, NativeReceipt, NativeReviewInput } from '../../../packages/shared/src/native-fsrs.js';
import { NativeStore } from '../src/native-store.js';
import { currentNativeConfig } from '../src/native-scheduler.js';
import { SQLiteNativeStorage } from '../src/sqlite-native-storage.js';
import { PostgresNativeStore } from '../src/postgres/native-store.js';
import { withOwnerTransaction } from '../src/postgres/transaction.js';
import { readHostedConfig } from '../src/hosted-config.js';
import { createHostedSeiServer } from '../src/hosted-app.js';
import { createPostgresHarness, type PostgresHarness } from './harness.js';

const t0 = '2026-11-09T00:00:00.000Z';
const t1 = '2026-11-10T00:00:00.000Z';
const immutable = ['native_scheduler_configs', 'native_card_versions', 'native_flashcard_events'] as const;
const tables = [...immutable, 'native_flashcard_projections'] as const;
const claims = (sub: string) => ({ sub, role: 'authenticated' as const });
function syntheticCatalog(count = 12): Catalog {
  return { schemaVersion: 1, sources: [], objectives: [], statements: [], competencies: [], indicators: [],
    skills: [], alignments: [], prerequisites: [], lessons: [], tasks: [], mentorTexts: [], rubrics: [], reviewEvents: [],
    cards: Array.from({ length: count }, (_, index) => ({ id: `synthetic-${String(index + 1).padStart(2, '0')}`,
      front: `Synthetic front ${index}`, back: `Synthetic back ${index}`, source: 'Synthetic test only', tags: ['synthetic'] })) };
}
function review(item: NativeQueueItem, now = t0, overrides: Partial<NativeReviewInput> = {}): NativeReviewInput {
  return { clientEventId: randomUUID(), cardId: item.card.id, cardFingerprint: item.cardFingerprint,
    expectedVersion: item.version, response: '  Synthetic recall\nwith original spacing  ', assistance: ['synthetic notes'],
    hintCount: 1, rating: 3, revealed: true, startedAt: now, revealedAt: now, clientNow: now, ...overrides };
}
function control(item: NativeQueueItem, action: NativeControlInput['action'], now = t0): NativeControlInput {
  return { clientEventId: randomUUID(), cardId: item.card.id, cardFingerprint: item.cardFingerprint,
    expectedVersion: item.version, clientNow: now, action };
}

describe('hosted foundation on a disposable real Postgres database', () => {
  let harness: PostgresHarness;
  const apps: FastifyInstance[] = [];
  const seedOwner = randomUUID();
  const seedCatalog = syntheticCatalog(1);
  const run = <T>(owner: string, catalog: Catalog, operation: (store: PostgresNativeStore) => Promise<T>, now = t0) =>
    withOwnerTransaction(harness.pool, claims(owner), client => operation(new PostgresNativeStore(client, owner, catalog, () => new Date(now))));
  const snapshot = async (owner: string, names: readonly string[] = tables) => {
    const result: Record<string, unknown> = {};
    for (const table of names) {
      // Table names come only from the fixed test constants above.
      const rows = await harness.database.query(`SELECT to_jsonb(t) AS row FROM sei.${table} t WHERE owner_id=$1 ORDER BY to_jsonb(t)::text`, [owner]);
      result[table] = rows.rows;
    }
    return result;
  };
  beforeAll(async () => {
    harness = await createPostgresHarness();
    await run(seedOwner, seedCatalog, store => store.initialize());
  });
  afterAll(async () => {
    await Promise.all(apps.splice(0).map(app => app.close()));
    if (harness) await harness.dispose();
  });

  it('cannot read either neighboring application, whose synthetic data remains unchanged', async () => {
    for (const sql of ['SELECT * FROM public.answers', 'SELECT * FROM lesson_planning.lessons']) {
      await expect(harness.pool.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    expect((await harness.database.query('SELECT payload FROM public.answers')).rows).toEqual([{ payload: 'synthetic neighbor answer' }]);
    expect((await harness.database.query('SELECT payload FROM lesson_planning.lessons')).rows).toEqual([{ payload: 'synthetic neighbor lesson' }]);
  });

  it('uses a limited role, forced RLS on every table, and no immutable DELETE/TRUNCATE privileges', async () => {
    const role = (await harness.pool.query("SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolconnlimit FROM pg_roles WHERE rolname='sei_app'")).rows[0];
    expect(role).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false, rolconnlimit: 5 });
    for (const table of tables) {
      const row = (await harness.database.query('SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [`sei.${table}`])).rows[0];
      expect(row).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    }
    for (const table of immutable) {
      const privileges = (await harness.pool.query("SELECT has_table_privilege(current_user,$1,'DELETE') AS delete, has_table_privilege(current_user,$1,'TRUNCATE') AS truncate, has_table_privilege(current_user,$1,'UPDATE') AS update", [`sei.${table}`])).rows[0];
      expect(privileges).toEqual({ delete: false, truncate: false, update: false });
    }
    const publicUsage = await harness.database.query("SELECT EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) acl WHERE n.nspname='sei' AND acl.grantee=0 AND acl.privilege_type='USAGE') AS allowed");
    expect(publicUsage.rows[0].allowed).toBe(false);
  });

  it('allows owner initialization, review, controls, and history while preserving full JSON', async () => {
    const owner = randomUUID(), catalog = syntheticCatalog(1);
    expect(await run(owner, catalog, store => store.initialize())).toEqual({ initialized: 1 });
    expect(await run(owner, catalog, store => store.initialize())).toEqual({ initialized: 0 });
    const item = (await run(owner, catalog, store => store.queue())).queue[0];
    const payload = review(item);
    const receipt = await run(owner, catalog, store => store.review(payload));
    const suspended = await run(owner, catalog, store => store.control(control({ ...item, version: receipt.version }, 'suspend')));
    const held = (await run(owner, catalog, store => store.queue())).held[0];
    expect(held).toMatchObject({ version: suspended.version, suspended: true });
    await run(owner, catalog, store => store.control(control(held, 'resume')));
    const history = await run(owner, catalog, store => store.history(item.card.id));
    expect(history.map(event => event.kind)).toEqual(['init', 'review', 'control', 'control']);
    expect(history[1].request).toEqual(payload);
    expect(history[1].before?.schedule).toEqual(item.schedule);
    expect(history[1].after.schedule).toEqual(receipt.schedule);
    expect(history[1].config).toEqual(currentNativeConfig());
    expect(history[1].log).toMatchObject({ rating: 3, review: t0, due: t0 });
    expect((await run(owner, catalog, store => store.queue())).reviewsSynchronized).toBe(false);
  });

  it('filters other-user and absent claims and rejects forged owner inserts', async () => {
    const config = currentNativeConfig();
    await withOwnerTransaction(harness.pool, claims(randomUUID()), async client => {
      for (const table of tables) expect((await client.query(`SELECT * FROM sei.${table}`)).rows).toEqual([]);
    });
    await expect(withOwnerTransaction(harness.pool, claims(randomUUID()), client => client.query(
      'INSERT INTO sei.native_scheduler_configs(owner_id,hash,entity_json) VALUES($1,$2,$3::jsonb)',
      [seedOwner, config.hash, JSON.stringify(config)],
    ))).rejects.toMatchObject({ code: '42501' });
    for (const table of tables) expect((await harness.pool.query(`SELECT * FROM sei.${table}`)).rows).toEqual([]);
    await expect(harness.pool.query('INSERT INTO sei.native_scheduler_configs(owner_id,hash,entity_json) VALUES($1,$2,$3::jsonb)',
      [seedOwner, config.hash, JSON.stringify(config)])).rejects.toMatchObject({ code: '42501' });
  });

  it('clears verified claims on COMMIT and ROLLBACK before reusing the same pooled connection', async () => {
    const pool = new Pool({ ...harness.appConfig, max: 1 });
    try {
      const firstPid = await withOwnerTransaction(pool, claims(seedOwner), async client => {
        const state = (await client.query("SELECT pg_backend_pid() AS pid, current_setting('request.jwt.claims',true)::jsonb AS claims")).rows[0];
        expect(state.claims).toEqual(claims(seedOwner));
        expect((await client.query('SELECT * FROM sei.native_flashcard_events')).rows).toHaveLength(1);
        return state.pid;
      });
      const client = await pool.connect();
      try {
        expect((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid).toBe(firstPid);
        expect((await client.query('SELECT * FROM sei.native_flashcard_events')).rows).toEqual([]);
      } finally { client.release(); }
      await expect(withOwnerTransaction(pool, claims(seedOwner), async client => {
        expect((await client.query('SELECT * FROM sei.native_flashcard_events')).rows).toHaveLength(1);
        throw new Error('Synthetic rollback');
      })).rejects.toThrow('Synthetic rollback');
      expect((await pool.query('SELECT * FROM sei.native_flashcard_events')).rows).toEqual([]);
    } finally { await pool.end(); }
  });

  it('rejects immutable UPDATE/DELETE/TRUNCATE through grants and operator-level append-only triggers', async () => {
    const before = await snapshot(seedOwner, immutable);
    for (const table of immutable) {
      for (const statement of [`UPDATE sei.${table} SET owner_id=owner_id`, `DELETE FROM sei.${table}`, `TRUNCATE sei.${table} CASCADE`]) {
        await expect(withOwnerTransaction(harness.pool, claims(seedOwner), client => client.query(statement))).rejects.toMatchObject({ code: '42501' });
        // The table owner/admin bypasses grants and RLS, so this exercises triggers too.
        await expect(harness.database.query(statement)).rejects.toThrow(/append.only/i);
      }
    }
    expect(await snapshot(seedOwner, immutable)).toEqual(before);
  });

  it('returns original receipts across later state and conflicts on reused payload IDs or versions', async () => {
    const owner = randomUUID(), catalog = syntheticCatalog(1);
    await run(owner, catalog, store => store.initialize());
    const item = (await run(owner, catalog, store => store.queue())).queue[0];
    const payload = review(item), receipt = await run(owner, catalog, store => store.review(payload));
    await run(owner, catalog, store => store.control(control({ ...item, version: receipt.version }, 'suspend')));
    catalog.cards[0].front = 'Revised synthetic wording';
    const before = await snapshot(owner);
    expect(await run(owner, catalog, store => store.review(payload))).toEqual(receipt);
    await expect(run(owner, catalog, store => store.review({ ...payload, response: payload.response + 'changed' }))).rejects.toMatchObject({ statusCode: 409 });
    await expect(run(owner, catalog, store => store.control({ ...control(item, 'keep'), clientEventId: payload.clientEventId }))).rejects.toMatchObject({ statusCode: 409 });
    expect(await snapshot(owner)).toEqual(before);

    const writerOwner = randomUUID(), writerCatalog = syntheticCatalog(1);
    await run(writerOwner, writerCatalog, store => store.initialize());
    const base = (await run(writerOwner, writerCatalog, store => store.queue())).queue[0];
    const results = await Promise.allSettled([review(base), review(base, t0, { rating: 4 })].map(input => run(writerOwner, writerCatalog, store => store.review(input))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find(result => result.status === 'rejected');
    expect(failure?.status === 'rejected' && failure.reason).toMatchObject({ statusCode: 409 });
    expect(await run(writerOwner, writerCatalog, store => store.history())).toHaveLength(2);
  });

  it('serializes simultaneous retries of the same client event into the same original receipt', async () => {
    const owner = randomUUID(), catalog = syntheticCatalog(1);
    await Promise.all([run(owner, catalog, store => store.initialize()), run(owner, catalog, store => store.initialize())]);
    const payload = review((await run(owner, catalog, store => store.queue())).queue[0]);
    const results = await Promise.all([run(owner, catalog, store => store.review(payload)), run(owner, catalog, store => store.review(payload))]);
    expect(results[0]).toEqual(results[1]);
    expect(await run(owner, catalog, store => store.history())).toHaveLength(2);
  });

  it('rebuilds missing projections from immutable events without changing original history', async () => {
    const owner = randomUUID(), catalog = syntheticCatalog(1);
    await run(owner, catalog, store => store.initialize());
    const queue = await run(owner, catalog, store => store.queue());
    await run(owner, catalog, store => store.review(review(queue.queue[0])));
    const expected = await run(owner, catalog, store => store.queue());
    const original = await snapshot(owner, immutable);
    await harness.database.query('DELETE FROM sei.native_flashcard_projections WHERE owner_id=$1', [owner]);
    await run(owner, catalog, store => store.rebuild());
    expect(await run(owner, catalog, store => store.queue())).toEqual(expected);
    expect(await snapshot(owner, immutable)).toEqual(original);
  });

  it('matches the SQLite adapter for full library states/logs, stale holds, controls, and a future-due Manual -7 reset', async () => {
    const owner = randomUUID(), catalog = syntheticCatalog(1);
    const db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);');
    let now = t0;
    const local = new SQLiteNativeStorage(new NativeStore(db, catalog, () => new Date(now)));
    const pg = <T>(operation: (store: PostgresNativeStore) => Promise<T>) => run(owner, catalog, operation, now);
    try {
      expect(await pg(store => store.initialize())).toEqual(await local.initialize());
      const compare = async () => {
        expect(await pg(store => store.queue())).toEqual(await local.queue());
        const normalize = (events: Awaited<ReturnType<NativeStore['history']>>) => events.map(({ id: _id, ...event }) => event);
        expect(normalize(await pg(store => store.history()))).toEqual(normalize(await local.history()));
      };
      await compare();
      const first = (await local.queue()).queue[0], input = review(first, now, { rating: 4 });
      const localReceipt = await local.review(input), hostedReceipt = await pg(store => store.review(input));
      const { eventId: _localId, ...localComparable } = localReceipt;
      const { eventId: _hostedId, ...hostedComparable } = hostedReceipt;
      expect(hostedComparable).toEqual(localComparable);
      expect(hostedReceipt.schedule.due).toBe('2026-11-17T00:00:00.000Z');
      await compare();
      now = t1;
      catalog.cards[0].front = 'Synthetic changed front';
      await compare();
      const held = (await local.queue()).held[0];
      await expect(pg(store => store.review(review(held, now)))).rejects.toMatchObject({ statusCode: 409 });
      await expect(local.review(review(held, now))).rejects.toMatchObject({ statusCode: 409 });
      const keep = control(held, 'keep', now);
      const kept = await local.control(keep);
      await pg(store => store.control(keep));
      await compare();
      const reset = control({ ...held, version: kept.version }, 'reset', now);
      await local.control(reset);
      await pg(store => store.control(reset));
      expect((await pg(store => store.history())).at(-1)?.log).toMatchObject({ rating: 0, scheduled_days: -7 });
      await compare();
      const suspend = control((await local.queue()).queue[0], 'suspend', now);
      await local.control(suspend); await pg(store => store.control(suspend));
      await compare();
      const resume = control((await local.queue()).held[0], 'resume', now);
      await local.control(resume); await pg(store => store.control(resume));
      await compare();
      await local.rebuild(); await pg(store => store.rebuild());
      await compare();
      catalog.cards.splice(0);
      await compare();
      expect((await pg(store => store.queue())).held[0].missing).toBe(true);
      expect((await harness.database.query('SELECT payload FROM public.answers')).rows).toEqual([{ payload: 'synthetic neighbor answer' }]);
    } finally { db.close(); }
  });

  it('serves owner-only HTTP, makes GET/HEAD read-only, persists after restart, and explicitly rejects unsupported routes', async () => {
    const owner = randomUUID(), catalog = syntheticCatalog();
    const config = readHostedConfig({ SEI_DATABASE_URL: harness.appUrl, SUPABASE_URL: 'https://synthetic.invalid',
      OWNER_USER_ID: owner, APP_ORIGINS: 'http://127.0.0.1:4317', APP_HOSTS: '127.0.0.1:4317' });
    const { privateKey, publicKey } = await generateKeyPair('ES256');
    const publicJwk = await exportJWK(publicKey);
    const key = createLocalJWKSet({ keys: [{ ...publicJwk, alg: 'ES256', use: 'sig', kid: 'synthetic' }] });
    const token = (sub: string) => new SignJWT({ role: 'authenticated' }).setProtectedHeader({ alg: 'ES256', kid: 'synthetic' })
      .setIssuer(config.issuer).setAudience('authenticated').setSubject(sub).setIssuedAt().setExpirationTime('10m').sign(privateKey);
    const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', authorization: `Bearer ${await token(owner)}` };
    const open = async () => {
      const app = await createHostedSeiServer({ config, pool: harness.pool, key, catalog, clock: () => new Date(t0) });
      apps.push(app); return app;
    };
    let app = await open();
    expect((await app.inject({ url: '/api/native-flashcards', headers: { host: headers.host } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/native-flashcards', headers: { ...headers, authorization: `Bearer ${await token(randomUUID())}` } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/native-flashcards', headers: { ...headers, origin: 'https://untrusted.invalid' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/native-flashcards', headers: { ...headers, host: 'untrusted.invalid' } })).statusCode).toBe(403);
    const before = await snapshot(owner);
    for (const method of ['GET', 'HEAD'] as const) expect((await app.inject({ method, url: '/api/native-flashcards', headers })).statusCode).toBe(200);
    expect(await snapshot(owner)).toEqual(before);
    expect((await app.inject({ method: 'POST', url: '/api/native-flashcards/initialize', headers })).json()).toEqual({ initialized: 12 });
    const queue = (await app.inject({ url: '/api/native-flashcards', headers })).json<NativeQueueResponse>();
    expect(queue.queue).toHaveLength(12);
    const initialized = await snapshot(owner);
    for (const method of ['GET', 'HEAD'] as const) expect((await app.inject({ method, url: '/api/native-flashcards', headers })).statusCode).toBe(200);
    expect(await snapshot(owner)).toEqual(initialized);
    const payload = review(queue.queue[0]);
    const accepted = await app.inject({ method: 'POST', url: '/api/native-flashcards/reviews', headers, payload });
    expect(accepted.statusCode).toBe(200);
    const receipt = accepted.json<NativeReceipt>();
    expect((await app.inject({ method: 'POST', url: '/api/native-flashcards/reviews', headers, payload: { ...payload, response: 'conflict' } })).statusCode).toBe(409);
    await app.close(); apps.splice(apps.indexOf(app), 1);
    app = await open();
    expect((await app.inject({ method: 'POST', url: '/api/native-flashcards/reviews', headers, payload })).json()).toEqual(receipt);
    const history = await app.inject({ url: `/api/native-flashcards/history?cardId=${payload.cardId}`, headers });
    expect(history.statusCode).toBe(200);
    expect(history.json()).toHaveLength(2);
    expect((await app.inject({ url: '/api/identity', headers })).json()).toMatchObject({ ownerId: owner, storageMode: 'postgres', databaseRole: 'sei_app' });
    for (const [method, url] of [['POST', '/api/attempts'], ['GET', '/api/drafts/synthetic'], ['POST', '/api/import'],
      ['GET', '/api/export'], ['POST', '/api/writing'], ['POST', '/api/handoff'], ['GET', '/api/session'], ['GET', '/api/state']] as const) {
      const response = await app.inject({ method, url, headers });
      expect(response.statusCode).toBe(501);
      expect(response.json()).toEqual({ error: 'Not yet available in hosted mode' });
    }
    expect((await harness.database.query('SELECT payload FROM lesson_planning.lessons')).rows).toEqual([{ payload: 'synthetic neighbor lesson' }]);
  });
});
