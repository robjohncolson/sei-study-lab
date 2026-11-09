import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { createOwnerVerifier } from '../apps/server/src/hosted-auth.js';
import { createHostedSeiServer } from '../apps/server/src/hosted-app.js';
import { readHostedConfig } from '../apps/server/src/hosted-config.js';
import { withOwnerTransaction } from '../apps/server/src/postgres/transaction.js';
import type { Catalog } from '../packages/shared/src/index.js';

const owner = '05bce282-b04e-4fc6-8ddc-f3c3b271e131';
const other = 'cc434f8a-2a41-49c6-a563-e44cb412efcf';
const config = readHostedConfig({
  SEI_DATABASE_URL: 'postgresql://sei_app:synthetic-password@127.0.0.1/synthetic',
  SUPABASE_URL: 'https://synthetic.example.test', OWNER_USER_ID: owner,
  APP_ORIGINS: 'http://127.0.0.1:4317', APP_HOSTS: '127.0.0.1:4317',
});
const catalog: Catalog = { schemaVersion: 1, sources: [], objectives: [], statements: [], competencies: [],
  indicators: [], skills: [], alignments: [], prerequisites: [], lessons: [], tasks: [], cards: [],
  mentorTexts: [], rubrics: [], reviewEvents: [] };
const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317' };
let es: Awaited<ReturnType<typeof generateKeyPair>>;
let rsa: Awaited<ReturnType<typeof generateKeyPair>>;
let key: JWTVerifyGetKey;
const apps: Awaited<ReturnType<typeof createHostedSeiServer>>[] = [];
beforeAll(async () => {
  es = await generateKeyPair('ES256');
  rsa = await generateKeyPair('RS256');
  key = createLocalJWKSet({ keys: [
    { ...await exportJWK(es.publicKey), kid: 'es-test', alg: 'ES256', use: 'sig' },
    { ...await exportJWK(rsa.publicKey), kid: 'rs-test', alg: 'RS256', use: 'sig' },
  ] });
});
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });
async function token(changes: JWTPayload = {}, algorithm: 'ES256' | 'RS256' = 'ES256') {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: config.issuer, aud: 'authenticated', sub: owner, role: 'authenticated',
    iat: now, nbf: now - 10, exp: now + 300, ...changes })
    .setProtectedHeader({ alg: algorithm, kid: algorithm === 'ES256' ? 'es-test' : 'rs-test' })
    .sign(algorithm === 'ES256' ? es.privateKey : rsa.privateKey);
}
async function setup() {
  const connect = vi.fn(async () => { throw new Error('Rejected requests must not touch the database'); });
  const pool = { connect, end: vi.fn() } as unknown as Pool;
  const app = await createHostedSeiServer({ config, pool, key, catalog });
  apps.push(app);
  return { app, connect, pool };
}

describe('real asymmetric JWT authorization with a local JWKS', () => {
  it.each(['ES256', 'RS256'] as const)('accepts the exact owner with %s', async algorithm => {
    const authorization = `Bearer ${await token({}, algorithm)}`;
    expect(await createOwnerVerifier(config, key)(authorization)).toMatchObject({ sub: owner, role: 'authenticated' });
    const { app, connect } = await setup();
    const response = await app.inject({ url: '/api/attempts', headers: { ...headers, authorization } });
    expect(response.statusCode).toBe(501);
    expect(response.json()).toEqual({ error: 'Not yet available in hosted mode' });
    expect(connect).not.toHaveBeenCalled();
    expect(response.headers['set-cookie']).toBeUndefined();
  });
  it('rejects a valid other user before touching the database, even with owner metadata', async () => {
    const { app, connect } = await setup();
    const response = await app.inject({ url: '/api/health', headers: { ...headers,
      authorization: `Bearer ${await token({ sub: other, user_metadata: { sub: owner, role: 'authenticated', owner: true } })}` } });
    expect(response.statusCode).toBe(403);
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([
    ['issuer', { iss: 'https://wrong.example.test/auth/v1' }],
    ['audience', { aud: 'anon' }],
    ['expired', { exp: 1 }],
    ['future nbf', { nbf: 4_000_000_000 }],
    ['role', { role: 'service_role' }],
    ['missing role', { role: undefined }],
    ['invalid sub', { sub: 'not-a-uuid' }],
    ['missing sub', { sub: undefined }],
    ['missing exp', { exp: undefined }],
  ] satisfies [string, JWTPayload][])('rejects %s before database access', async (_name, changes) => {
    const { app, connect } = await setup();
    const response = await app.inject({ url: '/api/native-flashcards', headers: { ...headers,
      authorization: `Bearer ${await token(changes)}` } });
    expect(response.statusCode).toBe(401);
    expect(connect).not.toHaveBeenCalled();
  });
  it('rejects HS256, none, tampered signatures, malformed and missing tokens before database access', async () => {
    const { app, connect } = await setup();
    const claims = { iss: config.issuer, aud: 'authenticated', sub: owner, role: 'authenticated', exp: Math.floor(Date.now() / 1000) + 300 };
    const hs = await new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).sign(new Uint8Array(32).fill(7));
    const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
    const signed = await token();
    const parts = signed.split('.');
    parts[2] = (parts[2][0] === 'A' ? 'B' : 'A') + parts[2].slice(1);
    const rejected: (string | undefined)[] = [`Bearer ${hs}`, `Bearer ${none}`, `Bearer ${parts.join('.')}`,
      'Bearer broken', 'Basic synthetic', '', undefined];
    for (const authorization of rejected) {
      const response = await app.inject({ url: '/api/native-flashcards', headers: { ...headers,
        ...(authorization === undefined ? {} : { authorization }), cookie: 'sei_session=synthetic' } });
      expect(response.statusCode).toBe(401);
      expect(response.body).not.toContain(signed);
    }
    expect(connect).not.toHaveBeenCalled();
  });
  it('guards Host and any supplied Origin and requires Origin on unsafe methods', async () => {
    const { app, connect } = await setup();
    const authorization = `Bearer ${await token()}`;
    for (const candidate of [
      { ...headers, authorization, host: 'untrusted.example.test' },
      { ...headers, authorization, origin: 'https://untrusted.example.test' },
      { ...headers, authorization, origin: '' },
    ]) {
      expect((await app.inject({ url: '/api/native-flashcards', headers: candidate })).statusCode).toBe(403);
    }
    expect((await app.inject({ method: 'POST', url: '/api/native-flashcards/initialize',
      headers: { host: headers.host, authorization } })).statusCode).toBe(403);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('hosted transaction ownership', () => {
  it('sets verified claims immediately after BEGIN, commits once, and releases', async () => {
    const claims = await createOwnerVerifier(config, key)(`Bearer ${await token()}`);
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }));
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    const result = await withOwnerTransaction(pool, claims, async checkedOut => {
      expect(checkedOut).toBe(client);
      await checkedOut.query('SELECT 1');
      return 'synthetic';
    });
    expect(result).toBe('synthetic');
    expect(query.mock.calls).toEqual([
      ['BEGIN'],
      ["select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [JSON.stringify(claims), owner]],
      ['SELECT 1'], ['COMMIT'],
    ]);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
  it('rolls back and releases after an operation error', async () => {
    const claims = await createOwnerVerifier(config, key)(`Bearer ${await token()}`);
    const query = vi.fn(async (_text: string, _values?: unknown[]) => ({ rows: [] }));
    const release = vi.fn();
    const client = { query, release } as unknown as PoolClient;
    const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
    await expect(withOwnerTransaction(pool, claims, async () => { throw new Error('synthetic failure'); })).rejects.toThrow('synthetic failure');
    expect(query.mock.calls.map(call => call[0])).toEqual(['BEGIN',
      "select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", 'ROLLBACK']);
    expect(release).toHaveBeenCalledExactlyOnceWith(false);
  });
});
