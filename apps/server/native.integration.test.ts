import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { CatalogSchema } from '../../packages/shared/src/index.js';
import type { NativeQueueResponse, NativeReceipt, NativeReviewInput } from '../../packages/shared/src/native-fsrs.js';
import { createSeiServer } from './src/app.js';

const catalog = CatalogSchema.parse(JSON.parse(readFileSync('content/catalog.json', 'utf8')));
const apps: Awaited<ReturnType<typeof createSeiServer>>[] = [];
afterEach(async () => { for (const app of apps.splice(0)) await app.close(); });

async function setup() {
  let now = new Date('2026-11-09T00:00:00.000Z');
  const app = await createSeiServer({ catalog: structuredClone(catalog), dbPath: ':memory:', clock: () => now });
  apps.push(app);
  const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
  const headers = {
    host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317',
    cookie: String(session.headers['set-cookie']).split(';')[0],
    'x-csrf-token': session.json<{ csrfToken: string }>().csrfToken,
  };
  expect((await app.inject({ method: 'POST', url: '/api/native-flashcards/initialize', headers })).statusCode).toBe(200);
  const queue = (await app.inject({ url: '/api/native-flashcards', headers })).json<NativeQueueResponse>();
  const first = queue.queue[0];
  const input: NativeReviewInput = {
    clientEventId: randomUUID(), cardId: first.card.id, cardFingerprint: first.cardFingerprint,
    expectedVersion: first.version, clientNow: queue.serverNow, startedAt: queue.serverNow,
    revealedAt: queue.serverNow, revealed: true, response: '  Espa\u00f1ol \ud83c\udf31\r\n\tkeep spacing  ',
    hintCount: 1, assistance: ['consulted notes'], rating: 3,
  };
  const review = (payload: unknown) => app.inject({ method: 'POST', url: '/api/native-flashcards/reviews',
    headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  return { app, headers, queue, input, review, advance: (value: string) => { now = new Date(value); } };
}

describe('native review API, isolated in-memory databases', () => {
  it('keeps unauthenticated GET and HEAD read-only until a protected initialization command', async () => {
    let now = new Date('2026-11-09T00:00:00.000Z');
    const app = await createSeiServer({ catalog, dbPath: ':memory:', clock: () => now }); apps.push(app);
    const headers = { host: '127.0.0.1:4317', 'sec-fetch-site': 'cross-site' };
    const state = (await app.inject({ url: '/api/state', headers })).json();
    expect((await app.inject({ url: '/api/export', headers })).statusCode).toBe(200);
    for (const method of ['GET', 'HEAD'] as const) {
      const response = await app.inject({ method, url: '/api/native-flashcards', headers });
      expect(response.statusCode).toBe(200);
      if (method === 'GET') expect(response.json<NativeQueueResponse>()).toMatchObject({ queue: [], held: [], nextDue: null });
      for (const command of ['initialize', 'reviews', 'controls']) {
        expect((await app.inject({ method, url: `/api/native-flashcards/${command}`, headers })).statusCode).toBe(404);
      }
      // Legacy export refuses any native history, including an init-only history.
      expect((await app.inject({ url: '/api/export', headers })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/state', headers })).json()).toEqual(state);
    }
    const session = await app.inject({ url: '/api/session', headers: { host: headers.host } });
    const protectedHeaders = { host: headers.host, origin: 'http://127.0.0.1:4317',
      cookie: String(session.headers['set-cookie']).split(';')[0],
      'x-csrf-token': session.json<{ csrfToken: string }>().csrfToken };
    const initialize = () => app.inject({ method: 'POST', url: '/api/native-flashcards/initialize', headers: protectedHeaders });
    const enrolled = await initialize();
    expect(enrolled.statusCode).toBe(200);
    expect(enrolled.json()).toEqual({ initialized: 12 });
    const queue = (await app.inject({ url: '/api/native-flashcards', headers })).json<NativeQueueResponse>();
    expect(queue.queue).toHaveLength(12);
    expect(new Set(queue.queue.map(item => item.card.id)).size).toBe(12);
    expect(queue.queue.every(item => item.version === 1 && item.schedule.due === now.toISOString())).toBe(true);
    now = new Date('2026-11-10T00:00:00.000Z');
    // Repeating the command also covers retry after its response was lost.
    const retried = await initialize();
    expect(retried.statusCode).toBe(200);
    expect(retried.json()).toEqual({ initialized: 0 });
    for (const method of ['GET', 'HEAD'] as const) {
      expect((await app.inject({ method, url: '/api/native-flashcards', headers })).statusCode).toBe(200);
      expect((await app.inject({ url: '/api/native-flashcards', headers })).json()).toEqual({ ...queue, serverNow: now.toISOString() });
    }
    expect((await app.inject({ url: '/api/state', headers })).json()).toEqual(state);
    const blocked = await app.inject({ url: '/api/export', headers });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json<{ error: string }>().error).toContain('db:backup');
  });

  it('requires a trusted Origin and matching current session cookie/token to initialize', async () => {
    const app = await createSeiServer({ catalog, dbPath: ':memory:' }); apps.push(app);
    const host = '127.0.0.1:4317';
    const session = await app.inject({ url: '/api/session', headers: { host } });
    const headers = { host, origin: `http://${host}`, cookie: String(session.headers['set-cookie']).split(';')[0],
      'x-csrf-token': session.json<{ csrfToken: string }>().csrfToken };
    const secondSession = await app.inject({ url: '/api/session', headers: { host } });
    const invalidHeaders = [
      { host, 'sec-fetch-site': 'same-origin' },
      ...['origin', 'cookie', 'x-csrf-token'].map(key => Object.fromEntries(Object.entries(headers).filter(([name]) => name !== key))),
      { ...headers, origin: 'https://outside.invalid' },
      { ...headers, host: 'outside.invalid' },
      { ...headers, cookie: `sei_session=${'0'.repeat(64)}` },
      { ...headers, 'x-csrf-token': 'wrong' },
      { ...headers, cookie: String(secondSession.headers['set-cookie']).split(';')[0] },
    ];
    for (const requestHeaders of invalidHeaders) {
      expect((await app.inject({ method: 'POST', url: '/api/native-flashcards/initialize', headers: requestHeaders })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/export', headers: { host } })).statusCode).toBe(200);
    }
    const expiredClock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 86400001);
    try {
      expect((await app.inject({ method: 'POST', url: '/api/native-flashcards/initialize', headers })).statusCode).toBe(403);
    } finally { expiredClock.mockRestore(); }
    expect((await app.inject({ url: '/api/native-flashcards', headers: { host } })).json<NativeQueueResponse>().queue).toEqual([]);
    expect((await app.inject({ url: '/api/export', headers: { host } })).statusCode).toBe(200);
  });

  it('preserves CSRF/Host/Origin checks for both review and control writes', async () => {
    const { app, headers, input } = await setup();
    for (const url of ['/api/native-flashcards/reviews', '/api/native-flashcards/controls']) {
      expect((await app.inject({ method: 'POST', url, headers: { ...headers, 'x-csrf-token': 'wrong' }, payload: input })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: { ...headers, origin: 'https://outside.invalid' }, payload: input })).statusCode).toBe(403);
      expect((await app.inject({ method: 'POST', url, headers: { ...headers, host: 'outside.invalid' }, payload: input })).statusCode).toBe(403);
    }
  });

  it('returns the original receipt on retry after a later review advances state', async () => {
    const { review, input, advance, app, headers } = await setup();
    const accepted = await review(input);
    expect(accepted.statusCode).toBe(200);
    const receipt = accepted.json<NativeReceipt>();
    advance('2026-11-10T00:00:00.000Z');
    expect((await review({ ...input, clientEventId: randomUUID(), expectedVersion: receipt.version,
      clientNow: '2026-11-10T00:00:00.000Z', startedAt: '2026-11-10T00:00:00.000Z', revealedAt: '2026-11-10T00:00:00.000Z' })).statusCode).toBe(200);
    const before = (await app.inject({ url: '/api/native-flashcards', headers })).json();
    expect((await review(input)).json()).toEqual(receipt);
    expect((await review({ ...input, response: input.response + 'changed' })).statusCode).toBe(409);
    expect((await app.inject({ url: '/api/native-flashcards', headers })).json()).toEqual(before);
  });

  it('accepts one of two concurrent expected-version writes and leaves readiness unchanged', async () => {
    const { app, headers, input, review } = await setup();
    const before = (await app.inject({ url: '/api/state', headers })).json();
    const replies = await Promise.all([review(input), review({ ...input, clientEventId: randomUUID(), rating: 4 })]);
    expect(replies.map(r => r.statusCode).sort()).toEqual([200, 409]);
    expect((await app.inject({ url: '/api/state', headers })).json()).toEqual(before);
    const queue = (await app.inject({ url: '/api/native-flashcards', headers })).json<NativeQueueResponse>();
    expect(queue.queue.some(item => item.card.id === input.cardId)).toBe(false);
  });

  it('rejects invalid times, ratings, missing reveal and client-chosen due dates without mutation', async () => {
    const { app, headers, input, review, queue } = await setup();
    for (const payload of [
      { ...input, rating: 0 }, { ...input, rating: 5 }, { ...input, rating: null },
      { ...input, revealed: false }, { ...input, clientNow: 'invalid' },
      { ...input, revealedAt: '2026-11-10T00:00:00.000Z' },
      { ...input, dueAt: '2027-01-01T00:00:00.000Z' },
    ]) expect((await review(payload)).statusCode).toBe(400);
    expect((await app.inject({ url: '/api/native-flashcards', headers })).json()).toEqual(queue);
  });

  it('validates control writes and rejects stale controls with 409', async () => {
    const { app, headers, input, review } = await setup();
    const control = { clientEventId: randomUUID(), cardId: input.cardId, cardFingerprint: input.cardFingerprint,
      expectedVersion: input.expectedVersion, clientNow: input.clientNow, action: 'suspend' };
    expect((await app.inject({ method: 'POST', url: '/api/native-flashcards/controls', headers, payload: { ...control, action: 'delete' } })).statusCode).toBe(400);
    expect((await review(input)).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url: '/api/native-flashcards/controls', headers, payload: control })).statusCode).toBe(409);
  });

  it('refuses legacy export after native initialization and refuses unknown scheduler imports', async () => {
    const { app, headers } = await setup();
    const blocked = await app.inject({ url: '/api/export', headers });
    expect(blocked.statusCode).toBe(400);
    expect(blocked.json<{ error: string }>().error).toContain('db:backup');
    const oldApp = await createSeiServer({ catalog, dbPath: ':memory:' }); apps.push(oldApp);
    const oldExport = (await oldApp.inject({ url: '/api/export', headers: { host: headers.host } })).json();
    const preview = (payload: unknown) => app.inject({ method: 'POST', url: '/api/import/preview', headers, payload: { payload } });
    expect((await preview(oldExport)).statusCode).toBe(200);
    expect((await preview({ ...oldExport, nativeScheduler: { model: 'FSRS-7' } })).statusCode).toBe(400);
  });
});
