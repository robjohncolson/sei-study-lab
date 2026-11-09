import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { createSeiServer } from './src/app.js';

const apps: Awaited<ReturnType<typeof createSeiServer>>[] = [];
const host = '127.0.0.1:4317';
const origin = `http://${host}`;
const password = () => randomBytes(24).toString('base64url');
const environment = (extra: NodeJS.ProcessEnv = {}) => ({
  LOCAL_AUTH: 'password', SEI_SESSION_SECRET: randomBytes(32).toString('hex'), ...extra,
});
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });

async function setup(env: NodeJS.ProcessEnv = environment(), clock?: () => Date) {
  const app = await createSeiServer({ dbPath: ':memory:', env, clock });
  apps.push(app);
  const session = await app.inject({ url: '/api/session', headers: { host } });
  const csrfCookie = String(session.headers['set-cookie']).split(';')[0];
  const headers = { host, origin, cookie: csrfCookie, 'x-csrf-token': String(session.json().csrfToken) };
  return { app, session, headers, csrfCookie };
}

describe('optional local password authentication', () => {
  it('keeps the default API responses and CSRF cookie unchanged', async () => {
    const { app, session, headers } = await setup({});
    expect(Object.keys(session.json())).toEqual(['csrfToken']);
    expect(headers.cookie.startsWith('sei_session=')).toBe(true);
    expect((await app.inject({ url: '/api/state', headers: { host } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/native-flashcards/initialize', headers })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/native-flashcards/initialize', headers: { host, origin } })).statusCode).toBe(403);
  });

  it('requires sign-in across study routes and signs up, logs out, and logs in', async () => {
    const { app, session, headers, csrfCookie } = await setup();
    expect(session.json()).toMatchObject({ storageMode: 'sqlite', authMode: 'password',
      signedIn: false, username: null, signupOpen: true, setupCodeRequired: false });
    expect(csrfCookie.startsWith('sei_csrf=')).toBe(true);
    for (const [method, url] of [
      ['GET', '/api/state'], ['GET', '/api/native-flashcards'], ['GET', '/api/ai-feedback/status'],
      ['GET', '/api/export'], ['GET', '/api/drafts/task'], ['POST', '/api/attempts'],
      ['POST', '/api/import/preview'], ['POST', '/api/handoff'], ['POST', '/api/proposals/approve'],
      ['PUT', '/api/drafts/task'],
    ] as const) {
      const response = await app.inject({ method, url, headers });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toEqual({ error: 'Sign in required' });
    }
    expect((await app.inject({ url: '/api/catalog', headers })).statusCode).toBe(200);
    const secret = password();
    const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', headers,
      payload: { username: 'Local.Owner', password: secret } });
    expect(signup.statusCode).toBe(200);
    const authCookie = String(signup.headers['set-cookie']).split(';')[0];
    expect(authCookie.startsWith('sei_session=')).toBe(true);
    headers.cookie = `${csrfCookie}; ${authCookie}`;
    expect((await app.inject({ url: '/api/state', headers })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/session', headers })).json()).toMatchObject({
      signedIn: true, username: 'local.owner', signupOpen: false,
    });
    expect((await app.inject({ method: 'POST', url: '/api/auth/signup', headers,
      payload: { username: 'another.owner', password: password() } })).statusCode).toBe(403);
    const logout = await app.inject({ method: 'POST', url: '/api/auth/logout', headers });
    expect(logout.statusCode).toBe(200);
    expect(String(logout.headers['set-cookie']).includes('Max-Age=0')).toBe(true);
    expect((await app.inject({ url: '/api/state', headers })).statusCode).toBe(401);
    headers.cookie = csrfCookie;
    const incorrect = await app.inject({ method: 'POST', url: '/api/auth/login', headers,
      payload: { username: 'local.owner', password: password() } });
    expect(incorrect.statusCode).toBe(401);
    expect(incorrect.json()).toEqual({ error: 'Invalid username or password' });
    const login = await app.inject({ method: 'POST', url: '/api/auth/login', headers,
      payload: { username: 'LOCAL.OWNER', password: secret } });
    expect(login.statusCode).toBe(200);
    headers.cookie = `${csrfCookie}; ${String(login.headers['set-cookie']).split(';')[0]}`;
    expect((await app.inject({ url: '/api/state', headers })).statusCode).toBe(200);
    expect(signup.body.includes(secret) || login.body.includes(secret)).toBe(false);
  });

  it('uses one local history even when additional local accounts are allowed', async () => {
    const { app, headers, csrfCookie } = await setup(environment({ LOCAL_ALLOW_SIGNUP: 'true' }), () => new Date('2026-11-09T12:00:00Z'));
    const first = await app.inject({ method: 'POST', url: '/api/auth/signup', headers,
      payload: { username: 'first.owner', password: password() } });
    expect(first.statusCode).toBe(200);
    headers.cookie = `${csrfCookie}; ${String(first.headers['set-cookie']).split(';')[0]}`;
    await app.inject({ method: 'POST', url: '/api/native-flashcards/initialize', headers });
    const firstQueue = (await app.inject({ url: '/api/native-flashcards', headers })).json();
    const second = await app.inject({ method: 'POST', url: '/api/auth/signup', headers,
      payload: { username: 'second.owner', password: password() } });
    expect(second.statusCode).toBe(200);
    headers.cookie = `${csrfCookie}; ${String(second.headers['set-cookie']).split(';')[0]}`;
    const secondQueue = (await app.inject({ url: '/api/native-flashcards', headers })).json();
    expect(secondQueue).toEqual(firstQueue);
  });

  it('expires local login sessions with the injected clock', async () => {
    let now = new Date('2026-11-09T12:00:00Z');
    const { app, headers, csrfCookie } = await setup(environment(), () => now);
    const signup = await app.inject({ method: 'POST', url: '/api/auth/signup', headers,
      payload: { username: 'local.owner', password: password() } });
    headers.cookie = `${csrfCookie}; ${String(signup.headers['set-cookie']).split(';')[0]}`;
    now = new Date(now.getTime() + 30 * 86_400_000);
    expect((await app.inject({ url: '/api/state', headers })).statusCode).toBe(401);
  });

  it('keeps Host, Origin, and CSRF checks on authentication requests', async () => {
    const { app, headers } = await setup();
    const payload = { username: 'local.owner', password: password() };
    for (const changed of [{ host: 'untrusted.example' }, { origin: 'https://untrusted.example' }, { 'x-csrf-token': '' }]) {
      expect((await app.inject({ method: 'POST', url: '/api/auth/signup', headers: { ...headers, ...changed }, payload })).statusCode).toBe(403);
    }
  });

  it('rejects invalid local settings without including their values', async () => {
    for (const [name, value] of [['LOCAL_AUTH', 'unsupported'], ['LOCAL_ALLOW_SIGNUP', 'invalid'], ['SEI_SESSION_SECRET', 'invalid']] as const) {
      let message = '';
      try { await createSeiServer({ dbPath: ':memory:', env: environment({ [name]: value }) }); }
      catch (error) { message = (error as Error).message; }
      expect(message).toContain(name);
      expect(message.includes(value)).toBe(false);
    }
  });
});
