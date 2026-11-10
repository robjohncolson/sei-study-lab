import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Pool } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogSchema } from '../../packages/shared/src/index.js';
import { FLASHCARD_AI_PRIVACY_NOTICE } from '../../packages/shared/src/flashcard-grade.js';
import { createSeiServer } from './src/app.js';
import { createHostedSeiServer, HOSTED_CSRF_TOKEN } from './src/hosted-app.js';
import { readHostedConfig } from './src/hosted-config.js';
import { nativeContentVersion } from './src/native-scheduler.js';
import { SqliteAiStorage } from './src/ai/sqlite-ai-storage.js';
import { readAiConfig } from './src/ai/ai-config.js';
import { estimateCostMicroUsd } from './src/ai/budget.js';
import { buildFlashcardGradeRequest, FlashcardGradeOutputError, FlashcardGradeRequestError, validateFlashcardGradeOutput } from './src/ai/flashcard-grade.js';

const catalog = CatalogSchema.parse(JSON.parse(readFileSync('content/catalog.json', 'utf8')));
const card = { id: 'synthetic-card-identity', front: 'What does SIFE mean?', back: 'Students with interrupted formal education', source: 'Derived practice', tags: [] };
const fixture = { ...catalog, cards: [card] };
const day = '2026-11-09';
const fakeKey = 'synthetic-provider-key-NEVER-REAL';
const keyed = { DEEPSEEK_API_KEY: fakeKey };
const envelope = (content = JSON.stringify({ closeness: 'close', explanation: 'You named students but omitted interrupted education.' }), usage = true) => ({
  choices: [{ message: { content }, finish_reason: 'stop' }],
  ...(usage ? { usage: { prompt_tokens: 100, completion_tokens: 10 } } : {}),
});
const apps: Awaited<ReturnType<typeof createSeiServer>>[] = [];
afterEach(async () => { vi.useRealTimers(); for (const app of apps.splice(0)) await app.close(); vi.restoreAllMocks(); });

async function setup(env: NodeJS.ProcessEnv = keyed, response: () => Promise<Response> = async () => Response.json(envelope()), cards = fixture.cards) {
  const fetch = vi.fn<typeof globalThis.fetch>(response);
  const reserve = vi.spyOn(SqliteAiStorage.prototype, 'reserve');
  const settle = vi.spyOn(SqliteAiStorage.prototype, 'settleUsage');
  const usage = vi.spyOn(SqliteAiStorage.prototype, 'usage');
  const finish = vi.spyOn(SqliteAiStorage.prototype, 'finish');
  const app = await createSeiServer({ dbPath: ':memory:', catalog: { ...fixture, cards }, env: {}, ai: { env, fetch }, clock: () => new Date('2026-11-09T17:00:00.000Z') });
  apps.push(app);
  const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', cookie: String(session.headers['set-cookie']).split(';')[0], 'x-csrf-token': session.json().csrfToken };
  const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers, payload });
  const body = { cardId: cards[0].id, cardFingerprint: nativeContentVersion(cards[0]), response: 'Students learning English' };
  const preview = () => post('/api/flashcard-grade/preview', body);
  const previewSha256 = cards[0].front.length <= 4000 && cards[0].back.length <= 8000
    ? buildFlashcardGradeRequest({ front: cards[0].front, back: cards[0].back, response: body.response, model: 'deepseek-flash' }).previewSha256 : 'a'.repeat(64);
  const payload = { ...body, previewSha256, consent: true };
  return { app, headers, post, fetch, body, payload, preview, reserve, settle, usage, finish };
}

describe('flashcard request and output validation', () => {
  it('binds the preview to content and model, preserves response text, and sends only the three fields', () => {
    const input = { front: card.front, back: card.back, response: '  My recall  ', model: 'deepseek-flash' };
    const request = buildFlashcardGradeRequest(input);
    expect(request.sentData).toEqual({ front: input.front, back: input.back, response: input.response });
    expect(JSON.parse(request.messages[1].content)).toEqual({ card_prompt: input.front, target_answer: input.back, learner_recall: input.response });
    expect(buildFlashcardGradeRequest({ ...input }).previewSha256).toBe(request.previewSha256);
    for (const changed of [{ front: 'Changed' }, { back: 'Changed' }, { response: 'Changed' }, { model: 'deepseek-other' }]) {
      expect(buildFlashcardGradeRequest({ ...input, ...changed }).previewSha256).not.toBe(request.previewSha256);
    }
  });
  it.each([{ front: 'x'.repeat(4001) }, { back: 'x'.repeat(8001) }, { response: 'x'.repeat(4001) }, { response: '  ' }])('rejects input limits before provider work (%j)', changed => {
    expect(() => buildFlashcardGradeRequest({ front: 'Prompt', back: 'Target', response: 'Recall', model: 'deepseek-flash', ...changed })).toThrow(FlashcardGradeRequestError);
  });
  it('accepts the exact input boundaries measured after trimming recall', () => {
    expect(() => buildFlashcardGradeRequest({ front: 'x'.repeat(4000), back: 'x'.repeat(8000), response: ` ${'x'.repeat(4000)} `, model: 'deepseek-flash' })).not.toThrow();
  });
  it.each(['\nMatch', 'Match\t', 'Match\u0000', 'Match\u007f', 'Match\u0085', '', ' '.repeat(2)])('rejects explanation controls and blanks (%j)', explanation => {
    expect(() => validateFlashcardGradeOutput(JSON.stringify({ closeness: 'correct', explanation }))).toThrow(FlashcardGradeOutputError);
  });
  it('trims ordinary spaces around a valid explanation', () => {
    expect(validateFlashcardGradeOutput('{"closeness":"correct","explanation":"  You matched the concept.  "}')).toEqual({ closeness: 'correct', explanation: 'You matched the concept.' });
  });
});

describe('consented flashcard closeness routes with mocked provider transport', () => {
  it('does no ledger access or fetch without a key, and reports unavailable', async () => {
    const { app, headers, post, payload, usage, reserve, fetch } = await setup({});
    const status = await app.inject({ url: '/api/flashcard-grade/status', headers });
    expect(status.json()).toMatchObject({ available: false, model: 'deepseek-flash', privacyNotice: FLASHCARD_AI_PRIVACY_NOTICE, remainingFlashcardRequestsToday: 0 });
    expect((await post('/api/flashcard-grade', payload)).statusCode).toBe(501);
    expect((await post('/api/flashcard-grade', { ...payload, cardId: 'stale-card' })).statusCode).toBe(501);
    expect(usage).not.toHaveBeenCalled(); expect(reserve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('previews only card content and frozen recall, without ledger access or fetch', async () => {
    const { preview, body, reserve, usage, settle, fetch } = await setup();
    const response = await preview();
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ available: true, sentData: { front: card.front, back: card.back, response: body.response }, privacyNotice: FLASHCARD_AI_PRIVACY_NOTICE });
    expect(Object.keys(response.json().sentData).sort()).toEqual(['back', 'front', 'response']);
    expect(reserve).not.toHaveBeenCalled(); expect(usage).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([undefined, false, 'true'])('requires explicit literal consent (%s)', async consent => {
    const { post, payload, reserve, fetch } = await setup();
    const result = await post('/api/flashcard-grade', { ...payload, consent });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toBe('Explicit consent is required before sending a card to DeepSeek');
    expect(reserve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects stale identities, hashes, blank/oversize recall and extra fields before ledger work', async () => {
    const { post, payload, body, reserve, fetch } = await setup();
    for (const url of ['/api/flashcard-grade/preview', '/api/flashcard-grade']) {
      const input = url.endsWith('/preview') ? body : payload;
      expect((await post(url, { ...input, cardFingerprint: '0'.repeat(64) })).statusCode).toBe(409);
      for (const response of ['', ' \n ', '...!?', 'x'.repeat(4001)]) expect((await post(url, { ...input, response })).statusCode).toBe(400);
      expect((await post(url, { ...input, ownerId: randomUUID() })).statusCode).toBe(400);
    }
    const stale = await post('/api/flashcard-grade', { ...payload, previewSha256: '0'.repeat(64) });
    expect(stale.statusCode).toBe(409); expect(stale.json().error).toContain('The preview changed');
    expect(reserve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{ front: 'x'.repeat(4001) }, { back: 'x'.repeat(8001) }])('rejects oversized catalog content before reserving', async changed => {
    const { post, payload, reserve, fetch } = await setup(keyed, undefined, [{ ...card, ...changed }]);
    expect((await post('/api/flashcard-grade', payload)).statusCode).toBe(400);
    expect(reserve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it('recognizes normalized exact recall without provider or ledger changes', async () => {
    const { post, body, reserve, settle, fetch } = await setup();
    const recall = { ...body, response: `  ${card.back.toUpperCase()}! ` };
    const preview = (await post('/api/flashcard-grade/preview', recall)).json();
    const response = await post('/api/flashcard-grade', { ...recall, previewSha256: preview.previewSha256, consent: true });
    expect(response.json()).toEqual({ closeness: 'correct', source: 'exact', explanation: 'Matches the target answer.' });
    expect(reserve).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['correct', 'close', 'incorrect'])('returns %s and settles only usage with 200-token output headroom', async closeness => {
    const explanation = 'You named the relevant concept.';
    const { app, headers, post, payload, fetch, reserve, settle, finish } = await setup(keyed, async () => Response.json(envelope(JSON.stringify({ closeness, explanation }))));
    const response = await post('/api/flashcard-grade', payload);
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ closeness, explanation, source: 'ai', warning: 'Unofficial AI closeness check. It is not an MTEL score and does not count as evidence.' });
    expect(reserve).toHaveBeenCalledWith(day, expect.any(Number), 1_500_000, 50);
    expect(settle).toHaveBeenCalledWith({ day, reservedMicroUsd: expect.any(Number), costMicroUsd: 42, inputTokens: 100, outputTokens: 10, retainReservation: false });
    const outbound = JSON.parse(String(fetch.mock.calls[0][1]?.body));
    expect(outbound).toMatchObject({ max_tokens: 200, response_format: { type: 'json_object' }, thinking: { type: 'disabled' } });
    expect(new Headers(fetch.mock.calls[0][1]?.headers).get('authorization')).toBe(`Bearer ${fakeKey}`);
    expect(outbound.messages).toHaveLength(2);
    expect(JSON.parse(outbound.messages[1].content)).toEqual({ card_prompt: card.front, target_answer: card.back, learner_recall: payload.response });
    for (const privateValue of [card.id, payload.cardFingerprint, fakeKey, 'hint', 'assistance', 'owner']) expect(String(fetch.mock.calls[0][1]?.body)).not.toContain(privateValue);
    expect(String(fetch.mock.calls[0][1]?.body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4}-\d\d-\d\dT\d\d:/i);
    expect(response.body).not.toContain(fakeKey); expect(finish).not.toHaveBeenCalled();
    const storage = settle.mock.contexts[0] as SqliteAiStorage;
    for (const table of ['ai_feedback_requests', 'attempts', 'judgments', 'evidence_events', 'native_flashcard_events']) {
      expect(storage.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
    }
    expect((await app.inject({ url: '/api/flashcard-grade/status', headers })).json().remainingFlashcardRequestsToday).toBe(49);
  });
  it.each(['not json', JSON.stringify({ closeness: 'correct', explanation: 'Matched', score: 4 }), JSON.stringify({ closeness: 'close', explanation: 'x'.repeat(301) })])('charges invalid output without creating review/evidence/history rows', async content => {
    const { post, payload, settle, finish } = await setup(keyed, async () => Response.json(envelope(content)));
    const response = await post('/api/flashcard-grade', payload);
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('The AI check could not be validated. Choose a rating yourself.');
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ costMicroUsd: 42, retainReservation: false }));
    const storage = settle.mock.contexts[0] as SqliteAiStorage;
    for (const table of ['ai_feedback_requests', 'attempts', 'judgments', 'evidence_events', 'native_flashcard_events']) expect(storage.store.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0);
    expect(finish).not.toHaveBeenCalled();
  });
  it.each([[429, 429], [500, 502]])('maps provider %i to safe %i without reading error bodies', async (providerStatus, status) => {
    const json = vi.fn(() => { throw new Error('Never read a provider error body'); });
    const { post, payload, settle } = await setup(keyed, async () => ({ ok: false, status: providerStatus, json } as unknown as Response));
    const response = await post('/api/flashcard-grade', payload);
    expect(response.statusCode).toBe(status); expect(response.json().error).toMatch(/Choose a rating yourself\.$/);
    expect(json).not.toHaveBeenCalled(); expect(settle).toHaveBeenCalledWith(expect.objectContaining({ retainReservation: true }));
  });
  it('releases an unreceived response reservation at zero cost', async () => {
    const { post, payload, settle } = await setup(keyed, async () => { throw new Error(fakeKey); });
    const response = await post('/api/flashcard-grade', payload);
    expect(response.statusCode).toBe(502); expect(response.body).not.toContain(fakeKey);
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ costMicroUsd: 0, retainReservation: false }));
  });
  it('retains the estimate when a received response has no usage', async () => {
    const { post, payload, settle } = await setup(keyed, async () => Response.json(envelope(undefined, false)));
    expect((await post('/api/flashcard-grade', payload)).statusCode).toBe(200);
    const storage = settle.mock.contexts[0] as SqliteAiStorage;
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ retainReservation: true }));
    expect((await storage.usage(day)).reservedMicroUsd).toBeGreaterThan(0);
  });
  it('times out a hung transport and offers manual ratings', async () => {
    const { post, payload, fetch, settle } = await setup(keyed, () => new Promise(() => {}));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = post('/api/flashcard-grade', payload);
    // inject is thenable; start it and let the mocked transport be reached.
    const responsePromise = Promise.resolve(pending);
    for (let index = 0; index < 100 && !fetch.mock.calls.length; index++) await new Promise<void>(resolve => setImmediate(resolve));
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(50_001);
    const response = await responsePromise;
    expect(response.statusCode).toBe(504); expect(response.json().error).toBe('The AI check timed out. Choose a rating yourself.');
    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ costMicroUsd: 0, retainReservation: false }));
  });
  it('stops the 51st flashcard reservation while the essay route can still reserve', async () => {
    const { post, payload, reserve, fetch } = await setup();
    for (let index = 0; index < 50; index++) expect((await post('/api/flashcard-grade', payload)).statusCode).toBe(200);
    const refused = await post('/api/flashcard-grade', payload);
    expect(refused.statusCode).toBe(429); expect(refused.json().error).toBe('Daily AI grading limit reached. Choose a rating yourself.');
    expect(fetch).toHaveBeenCalledTimes(50);
    const task = catalog.tasks.find(item => item.kind === 'writing')!, mentor = catalog.mentorTexts.find(item => item.id === task.mentorTextId)!;
    const attempt = await post('/api/attempts', { taskId: task.id, taskVersion: task.version, hintCount: 0,
      answer: { mentorTextId: mentor.id, mentorTextVersion: mentor.version, mentorTextHash: mentor.sha256, rubricVersionId: task.rubricVersionId,
        parts: Object.fromEntries(task.parts!.map(part => [part.id, 'Synthetic writing recall.'])) } });
    expect(attempt.statusCode).toBe(200);
    const attemptId = attempt.json().attempt.id;
    const preview = (await post('/api/ai-feedback/preview', { attemptId })).json();
    // This provider mock deliberately returns a flashcard shape, invalid for an essay;
    // reaching it proves the essay reservation remained available.
    expect((await post('/api/ai-feedback', { attemptId, previewSha256: preview.previewSha256, consent: true })).statusCode).toBe(502);
    expect(fetch).toHaveBeenCalledTimes(51); expect(reserve).toHaveBeenLastCalledWith(day, expect.any(Number), 2_000_000, 60);
  });
  it('enforces the shared 75% budget ceiling including outstanding reservations', async () => {
    const { app, headers, post, payload, usage, fetch } = await setup();
    await app.inject({ url: '/api/flashcard-grade/status', headers });
    const storage = usage.mock.contexts[0] as SqliteAiStorage;
    const config = { ...readAiConfig(keyed), maxOutputTokens: 200 };
    const estimate = estimateCostMicroUsd(buildFlashcardGradeRequest({ front: card.front, back: card.back, response: payload.response, model: config.model }).messages, config);
    expect(await storage.reserve(day, 1_500_000 - estimate + 1, 2_000_000, 60)).toBe(true);
    expect((await post('/api/flashcard-grade', payload)).statusCode).toBe(429); expect(fetch).not.toHaveBeenCalled();
    expect(await storage.reserve(day, estimate, 2_000_000, 60)).toBe(true);
  });
  it('accepts a reservation exactly at 75% and refuses the next one after actual spending', async () => {
    const { app, headers, post, payload, usage, fetch } = await setup();
    await app.inject({ url: '/api/flashcard-grade/status', headers });
    const storage = usage.mock.contexts[0] as SqliteAiStorage;
    const config = { ...readAiConfig(keyed), maxOutputTokens: 200 };
    const estimate = estimateCostMicroUsd(buildFlashcardGradeRequest({ front: card.front, back: card.back, response: payload.response, model: config.model }).messages, config);
    const spent = 1_500_000 - estimate;
    expect(await storage.reserve(day, spent, 2_000_000, 60)).toBe(true);
    await storage.settleUsage({ day, reservedMicroUsd: spent, costMicroUsd: spent, inputTokens: 0, outputTokens: 0 });
    expect((await post('/api/flashcard-grade', payload)).statusCode).toBe(200);
    expect((await post('/api/flashcard-grade', payload)).statusCode).toBe(429);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('does not expose a settlement error or create history on accounting failure', async () => {
    const { post, payload, settle, finish } = await setup();
    settle.mockRejectedValueOnce(new Error(`database details ${fakeKey}`));
    const response = await post('/api/flashcard-grade', payload);
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'AI grading could not be completed. Choose a rating yourself.' });
    expect(response.body).not.toContain(fakeKey); expect(finish).not.toHaveBeenCalled();
  });
  it('allows at least one flashcard request for a configured cap below ten', async () => {
    const { post, payload, reserve } = await setup({ ...keyed, AI_FEEDBACK_DAILY_REQUEST_CAP: '1' });
    expect((await post('/api/flashcard-grade', payload)).statusCode).toBe(200);
    expect(reserve).toHaveBeenCalledWith(day, expect.any(Number), 1_500_000, 1);
    expect((await post('/api/flashcard-grade', payload)).statusCode).toBe(429);
  });
  it('refuses disabled budget before ledger work', async () => {
    const { post, payload, reserve, fetch } = await setup({ ...keyed, AI_FEEDBACK_DAILY_BUDGET_USD: '0' });
    expect((await post('/api/flashcard-grade', payload)).statusCode).toBe(429);
    expect((await post('/api/flashcard-grade', { ...payload, cardId: 'stale-card' })).statusCode).toBe(429);
    expect(reserve).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
});

it('keeps every flashcard AI route behind hosted password sign-in', async () => {
  const config = readHostedConfig({ HOSTED_AUTH_MODE: 'password', PUBLIC_OWNER_ID: randomUUID(), SEI_SESSION_SECRET: randomBytes(32).toString('hex'),
    SEI_DATABASE_URL: 'postgresql://sei_app:synthetic@127.0.0.1/synthetic', APP_ORIGINS: 'http://127.0.0.1:4317', APP_HOSTS: '127.0.0.1:4317' });
  const connect = vi.fn(async () => { throw new Error('A signed-out request must not access the database'); });
  const fetch = vi.fn<typeof globalThis.fetch>();
  const app = await createHostedSeiServer({ config, pool: { connect } as unknown as Pool, catalog: fixture, ai: { env: keyed, fetch } });
  apps.push(app);
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317', 'x-csrf-token': HOSTED_CSRF_TOKEN };
  for (const [method, url] of [['GET', '/api/flashcard-grade/status'], ['POST', '/api/flashcard-grade/preview'], ['POST', '/api/flashcard-grade']] as const) {
    const response = await app.inject({ method, url, headers, ...(method === 'POST' ? { payload: {} } : {}) });
    expect(response.statusCode).toBe(401); expect(response.json()).toEqual({ error: 'Sign in required' });
  }
  expect(connect).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
});

