// Dependency-free, memory-only checks:
// node --experimental-transform-types --test tests/auth-pure.test.mjs
// Random credentials exist only in memory; assertions never print their values.
import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';

// Source uses emitted .js imports. Resolve only those internal imports to the
// checked-in TypeScript while Node transforms types; no build files are written.
const serverRoot = new URL('../apps/server/src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.startsWith(serverRoot)) {
      return nextResolve(specifier.slice(0, -3) + '.ts', context);
    }
    return nextResolve(specifier, context);
  },
});
const core = await import('../apps/server/src/auth/core.ts');
const { AuthService } = await import('../apps/server/src/auth/service.ts');
const { SqliteAuthStore } = await import('../apps/server/src/auth/sqlite-auth-store.ts');
const { readHostedConfig } = await import('../apps/server/src/hosted-config.ts');
hooks.deregister();

const credential = () => randomBytes(24).toString('base64url');
const localOrigins = new Set(['http://localhost:4317', 'http://127.0.0.1:4317']);
const migration = readFileSync(new URL('../apps/server/src/migrations/005-local-auth.sql', import.meta.url), 'utf8');
function fixture(t, extra = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(migration);
  let now = new Date('2026-11-09T12:00:00Z');
  const store = new SqliteAuthStore(db);
  const config = { sessionSecret: randomBytes(32).toString('hex'), firstOwner: randomUUID(),
    origins: localOrigins, allowSignup: false, ...extra };
  const service = new AuthService(store, config, () => now);
  return { db, store, config, service, now: () => now,
    advance: milliseconds => { now = new Date(now.getTime() + milliseconds); } };
}
async function rejectedCode(operation, expected) {
  let status;
  try { await operation(); } catch (error) { status = error.statusCode; }
  assert.equal(status, expected);
}
function rejectsInput(operation) {
  let rejected = false;
  try { operation(); } catch { rejected = true; }
  assert.equal(rejected, true);
}

test('scrypt format, wrong passwords, and missing or malformed dummy credentials', async () => {
  const password = credential();
  const hash = await core.hashPassword(password);
  assert.equal(/^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/.test(hash), true);
  assert.equal(await core.verifyPassword(password, hash), true);
  assert.equal(await core.verifyPassword(credential(), hash), false);
  for (const absent of [undefined, null, credential(), `${hash}\n`]) {
    assert.equal(await core.verifyPassword(password, absent), false);
  }
});

test('username and password boundaries reject malformed inputs', () => {
  assert.equal(core.normalizeUsername('Local.Owner'), 'local.owner');
  for (const username of ['ab', '.abc', 'a b', 'abc\n', 'a'.repeat(33), 'Kelvin', null]) {
    rejectsInput(() => core.normalizeUsername(username));
  }
  for (const password of ['', ' '.repeat(10), 'a'.repeat(9), 'a'.repeat(201), null]) {
    rejectsInput(() => core.validatePassword(password));
  }
  for (const password of ['a'.repeat(10), 'a'.repeat(200)]) {
    assert.equal(core.validatePassword(password) === password, true);
  }
});

test('session HMAC and cookie flags preserve secret and origin boundaries', () => {
  const secret = credential();
  const token = core.newSessionToken();
  const digest = core.hashSessionToken(secret, token);
  assert.equal(digest === createHmac('sha256', secret).update(token).digest('hex'), true);
  assert.equal(digest === token, false);
  assert.equal(digest === core.hashSessionToken(credential(), token), false);
  const localCookie = core.buildSessionCookie(localOrigins, token);
  assert.equal(localCookie.startsWith('sei_session='), true);
  assert.equal(localCookie.includes('; Secure;'), false);
  assert.equal(core.readSessionCookie(localOrigins, localCookie) === token, true);
  assert.equal(core.readSessionCookie(localOrigins, `${localCookie}; ${localCookie}`), null);
  for (const origins of [new Set(['https://study.example']), new Set([...localOrigins, 'https://study.example']), new Set()]) {
    const cookie = core.buildSessionCookie(origins, token);
    assert.equal(cookie.startsWith('__Host-sei_session='), true);
    assert.equal(cookie.includes('; Secure;'), true);
    assert.equal(cookie.includes('; HttpOnly;'), true);
    assert.equal(cookie.includes('; SameSite=Lax; Path=/; Max-Age=2592000'), true);
  }
  assert.equal(core.buildSessionCookie(localOrigins, null).includes('Max-Age=0'), true);
});

test('password configuration errors identify settings without exposing supplied values', () => {
  const env = { HOSTED_AUTH_MODE: 'password', SEI_DATABASE_URL: 'postgresql://sei_app@127.0.0.1/synthetic',
    PUBLIC_OWNER_ID: randomUUID(), APP_ORIGINS: 'http://localhost:4317', APP_HOSTS: 'localhost:4317',
    SEI_SESSION_SECRET: credential() };
  assert.equal(readHostedConfig(env).allowSignup, false);
  for (const [name, value] of [['SEI_SESSION_SECRET', 'too short'], ['PUBLIC_OWNER_ID', 'not-a-uuid'],
    ['AUTH_ALLOW_SIGNUP', 'unexpected-value'], ['AUTH_SETUP_CODE', '']]) {
    let safe = false;
    try { readHostedConfig({ ...env, [name]: value }); }
    catch (error) { safe = error.message.includes(name) && (value === '' || !error.message.includes(value)); }
    assert.equal(safe, true);
  }
});

test('rate limits cap both IP and username buckets and refill after a minute', () => {
  const limiter = new core.AuthRateLimiter();
  for (let i = 0; i < 10; i++) assert.equal(limiter.take('one-ip', `learner-${i}`, 0), true);
  assert.equal(limiter.take('one-ip', 'new-learner', 0), false);
  assert.equal(limiter.take('one-ip', 'new-learner', 60_000), true);
  const usernameLimit = new core.AuthRateLimiter();
  for (let i = 0; i < 10; i++) assert.equal(usernameLimit.take(`ip-${i}`, 'learner', 0), true);
  assert.equal(usernameLimit.take('another-ip', 'learner', 0), false);
});

test('SQLite migration is additive, idempotent, and enforces username and token constraints', t => {
  const { db } = fixture(t);
  db.exec(migration);
  const insert = db.prepare('INSERT INTO accounts(owner_id, username, password_hash, created_at) VALUES (?, ?, ?, ?)');
  const hash = `scrypt$${credential()}`;
  insert.run('first', 'first.owner', hash, new Date().toISOString());
  for (const username of ['Abc', '.abc', 'ab', 'a b', 'a/b', 'a'.repeat(33)]) {
    rejectsInput(() => insert.run(randomUUID(), username, hash, new Date().toISOString()));
  }
  rejectsInput(() => insert.run(randomUUID(), 'first.owner', hash, new Date().toISOString()));
  const session = db.prepare('INSERT INTO auth_sessions(token_hash, owner_id, created_at, expires_at) VALUES (?, ?, ?, ?)');
  for (const token of ['not-hex', 'G'.repeat(64), 'a'.repeat(63)]) {
    rejectsInput(() => session.run(token, 'first', new Date().toISOString(), new Date().toISOString()));
  }
  rejectsInput(() => session.run(randomBytes(32).toString('hex'), 'missing-owner', new Date().toISOString(), new Date().toISOString()));
  assert.equal(db.prepare('SELECT count(*) AS n FROM accounts').get().n, 1);
  assert.equal(db.prepare('SELECT count(*) AS n FROM auth_sessions').get().n, 0);
});

test('SQLite auth signs up and normalizes, closes signup, revokes, and expires sessions', async t => {
  const { db, config, service, advance } = fixture(t);
  const password = credential();
  const registration = await service.signup({ username: 'Local.Owner', password }, 'first-ip');
  const identity = await service.identity(registration.cookie);
  assert.equal(identity?.ownerId, config.firstOwner);
  assert.equal(identity?.username, 'local.owner');
  assert.equal((await service.status()).signupOpen, false);
  await rejectedCode(() => service.signup({ username: 'second.owner', password: credential() }, 'second-ip'), 403);
  assert.equal(db.prepare('SELECT password_hash FROM accounts').get().password_hash.startsWith('scrypt$'), true);
  const rawToken = core.readSessionCookie(localOrigins, registration.cookie);
  assert.equal(db.prepare('SELECT 1 FROM auth_sessions WHERE token_hash = ?').get(rawToken) === undefined, true);
  await service.logout(registration.cookie);
  assert.equal(await service.identity(registration.cookie), null);
  const login = await service.login({ username: 'LOCAL.OWNER', password }, 'first-ip');
  assert.equal(Boolean(await service.identity(login.cookie)), true);
  advance(30 * 86_400_000);
  assert.equal(await service.identity(login.cookie), null);
});

test('SQLite login lockout rejects the correct password until fifteen minutes pass', async t => {
  const { service, advance, store, config, now } = fixture(t);
  const password = credential();
  await service.signup({ username: 'local.owner', password }, 'first-ip');
  advance(61_000); // Leave the signup rate bucket; test the durable DB lock.
  for (let i = 0; i < 10; i++) {
    await rejectedCode(() => service.login({ username: 'local.owner', password: credential() }, 'first-ip'), 401);
  }
  // A racing successful verification must not clear an active lock.
  await store.loginResult(config.firstOwner, true, now());
  assert.equal((await store.loginLookup('local.owner', now())).locked, true);
  advance(61_000); // Leave the per-minute bucket while remaining inside the lock.
  await rejectedCode(() => service.login({ username: 'local.owner', password }, 'first-ip'), 401);
  advance(15 * 60_000);
  const login = await service.login({ username: 'local.owner', password }, 'first-ip');
  assert.equal(Boolean(await service.identity(login.cookie)), true);
  await rejectedCode(() => service.login({ username: 'missing.owner', password }, 'other-ip'), 401);
});

test('open registration requires setup codes and rejects case-insensitive duplicate names', async t => {
  const setupCode = credential();
  const { service, config } = fixture(t, { allowSignup: true, setupCode });
  assert.equal((await service.status()).setupCodeRequired, true);
  await rejectedCode(() => service.signup({ username: 'local.owner', password: credential() }, 'first-ip'), 403);
  await rejectedCode(() => service.signup({ username: 'local.owner', password: credential(), setupCode: credential() }, 'first-ip'), 403);
  await service.signup({ username: 'Local.Owner', password: credential(), setupCode }, 'first-ip');
  await rejectedCode(() => service.signup({ username: 'LOCAL.OWNER', password: credential(), setupCode }, 'first-ip'), 409);
  const second = await service.signup({ username: 'second.owner', password: credential(), setupCode }, 'second-ip');
  assert.equal((await service.identity(second.cookie)).ownerId !== config.firstOwner, true);
});
