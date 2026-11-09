import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CatalogSchema } from '../../packages/shared/src/index.js';
import { createSeiServer } from './src/app.js';
import { SqliteAiStorage } from './src/ai/sqlite-ai-storage.js';

// Every provider transport in this suite is injected; never contact the provider.
const catalog = CatalogSchema.parse(JSON.parse(readFileSync('content/catalog.json', 'utf8')));
const task = catalog.tasks.find(item => item.kind === 'writing')!;
const mentor = catalog.mentorTexts.find(item => item.id === task.mentorTextId)!;
const rubric = catalog.rubrics.find(item => `${item.id}@${item.version}` === task.rubricVersionId)!;
const answer = { mentorTextId: mentor.id, mentorTextVersion: mentor.version, mentorTextHash: mentor.sha256,
  rubricVersionId: task.rubricVersionId!, parts: Object.fromEntries(task.parts!.map(part => [part.id, 'I connect the content goal to evidence from the text.'])) };
const output = () => ({ criteriaFeedback: rubric.criteria.map(criterion => ({ criterionId: criterion.id,
  comment: 'Explain how the evidence informs instruction.', answerQuotes: ['content goal'], missingEvidence: ['A concrete assessment example'] })),
  holisticScore: 2, needsHumanReview: true, reason: 'Provisional rubric feedback requires review.' });
const envelope = (content = JSON.stringify(output()), finish_reason = 'stop') => ({
  choices: [{ message: { content }, finish_reason }],
  usage: { prompt_tokens: 1000, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600, completion_tokens: 100 },
});
const apps: Awaited<ReturnType<typeof createSeiServer>>[] = [];
afterEach(async () => { vi.useRealTimers(); for (const app of apps.splice(0)) await app.close(); vi.restoreAllMocks(); });
async function setup(env: NodeJS.ProcessEnv = {}, response: () => Promise<Response> = async () => Response.json(envelope())) {
  const fetch = vi.fn<typeof globalThis.fetch>(response);
  const app = await createSeiServer({ dbPath: ':memory:', catalog, ai: { env, fetch }, clock: () => new Date('2026-11-09T17:00:00Z') });
  apps.push(app);
  const session = await app.inject({ url: '/api/session', headers: { host: '127.0.0.1:4317' } });
  const headers = { host: '127.0.0.1:4317', origin: 'http://127.0.0.1:4317',
    cookie: String(session.headers['set-cookie']).split(';')[0], 'x-csrf-token': session.json().csrfToken };
  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url: `/api${url}`, headers, payload: payload as object });
  const submitted = await post('/attempts', { taskId: task.id, taskVersion: task.version, answer, hintCount: 0 });
  expect(submitted.statusCode).toBe(200);
  const attemptId = submitted.json().attempt.id as string;
  const preview = await post('/ai-feedback/preview', { attemptId });
  expect(preview.statusCode).toBe(200);
  const payload = { attemptId, previewSha256: preview.json().previewSha256, consent: true };
  return { app, post, headers, fetch, payload, preview };
}
const fakeKey = () => `sk-test-NOT-A-REAL-KEY-${randomUUID()}`;

describe('consented SQLite AI feedback', () => {
  it('returns unavailable and never calls fetch without a key', async () => {
    const { app, post, headers, fetch, payload } = await setup();
    const status = await app.inject({ url: '/api/ai-feedback/status', headers });
    expect(status.json()).toMatchObject({ available: false, provider: 'DeepSeek' });
    expect(status.json().reason).toContain('Grok handoff packet');
    const result = await post('/ai-feedback', payload);
    expect(result.statusCode).toBe(501);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([undefined, false, 'true'])('requires literal per-request consent (%s)', async consent => {
    const { post, payload, fetch } = await setup({ DEEPSEEK_API_KEY: fakeKey() });
    const result = await post('/ai-feedback', { ...payload, consent });
    expect(result.statusCode).toBe(400);
    expect(result.json().error).toBe('Explicit consent is required for each request');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects a changed preview and an unknown/non-writing attempt before fetch', async () => {
    const { post, payload, fetch } = await setup({ DEEPSEEK_API_KEY: fakeKey() });
    expect((await post('/ai-feedback', { ...payload, previewSha256: '0'.repeat(64) })).statusCode).toBe(409);
    expect((await post('/ai-feedback', { ...payload, attemptId: randomUUID() })).statusCode).toBe(404);
    const short = catalog.tasks.find(item => item.kind === 'short')!;
    const attempt = await post('/attempts', { taskId: short.id, taskVersion: short.version, answer: 'Synthetic answer', hintCount: 0 });
    expect((await post('/ai-feedback', { ...payload, attemptId: attempt.json().attempt.id })).statusCode).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('reconciles actual usage, limits requests, and approves once without evidence', async () => {
    const finish = vi.spyOn(SqliteAiStorage.prototype, 'finish');
    const key = fakeKey();
    const { app, post, headers, payload, fetch, preview } = await setup({ DEEPSEEK_API_KEY: key, AI_FEEDBACK_DAILY_REQUEST_CAP: '1' });
    const before = (await app.inject({ url: '/api/state', headers })).json();
    const result = await post('/ai-feedback', payload);
    expect(result.statusCode).toBe(200);
    const feedback = result.json();
    expect(feedback.proposal.proposedEvidence).toEqual([]);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ costMicroUsd: 303, inputTokens: 1000, outputTokens: 100 }));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(new Headers(options?.headers).get('Authorization')).toBe(`Bearer ${key}`);
    expect(options?.redirect).toBe('error');
    const outbound = JSON.parse(String(options?.body));
    expect(outbound).toMatchObject({ model: 'deepseek-flash', response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 1800 });
    expect(JSON.parse(outbound.messages[1].content)).toEqual(preview.json().sentData);
    expect((await post('/ai-feedback', payload)).statusCode).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await post('/ai-feedback/approve', { requestId: feedback.requestId, confirm: false })).statusCode).toBe(400);
    const approved = await post('/ai-feedback/approve', { requestId: feedback.requestId, confirm: true });
    expect(approved.json()).toMatchObject({ duplicate: false, evidenceEvents: [], judgment: {
      judgeKind: 'ai_approved_proposal', result: { status: 'needs_review', provisional: true, sourceChecked: false } } });
    expect((await post('/ai-feedback/approve', { requestId: feedback.requestId, confirm: true })).json().duplicate).toBe(true);
    expect((await post('/ai-feedback/approve', { requestId: randomUUID(), confirm: true })).statusCode).toBe(404);
    const after = (await app.inject({ url: '/api/state', headers })).json();
    expect(after.judgments.length).toBe(before.judgments.length + 1);
    expect(after.evidenceEvents).toEqual(before.evidenceEvents);
    expect(after.attempts).toEqual(before.attempts);
    expect((await app.inject({ url: '/api/ai-feedback/status', headers })).json().remainingRequestsToday).toBe(0);
  });
  it('refuses a worst-case reservation over budget without fetch', async () => {
    const { post, payload, fetch } = await setup({ DEEPSEEK_API_KEY: fakeKey(), AI_FEEDBACK_DAILY_BUDGET_USD: '0.000001' });
    const result = await post('/ai-feedback', payload);
    expect(result.statusCode).toBe(429);
    expect(result.json().error).toBe('Daily AI feedback limit reached. Use manual review.');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('disables a zero budget even if all configured prices are zero', async () => {
    const { post, payload, fetch } = await setup({ DEEPSEEK_API_KEY: fakeKey(), AI_FEEDBACK_DAILY_BUDGET_USD: '0',
      AI_FEEDBACK_PRICE_INPUT_MISS_PER_M: '0', AI_FEEDBACK_PRICE_INPUT_HIT_PER_M: '0', AI_FEEDBACK_PRICE_OUTPUT_PER_M: '0' });
    expect((await post('/ai-feedback', payload)).statusCode).toBe(429);
    expect(fetch).not.toHaveBeenCalled();
  });
  it('retains the worst-case reservation when a response has no usable usage', async () => {
    const finish = vi.spyOn(SqliteAiStorage.prototype, 'finish');
    const { post, payload } = await setup({ DEEPSEEK_API_KEY: fakeKey() }, async () => Response.json({ choices: envelope().choices }));
    expect((await post('/ai-feedback', payload)).statusCode).toBe(200);
    const completion = finish.mock.calls[0][0];
    expect(completion.retainReservation).toBe(true);
    expect(completion.costMicroUsd).toBe(completion.reservedMicroUsd);
    const storage = finish.mock.contexts[0] as SqliteAiStorage;
    expect(await storage.usage('2026-11-09')).toMatchObject({ requests: 1, spentMicroUsd: 0, reservedMicroUsd: completion.reservedMicroUsd });
  });
  it('serializes simultaneous local reservations before HTTP', async () => {
    const { post, payload, fetch } = await setup({ DEEPSEEK_API_KEY: fakeKey(), AI_FEEDBACK_DAILY_REQUEST_CAP: '1' });
    const results = await Promise.all([post('/ai-feedback', payload), post('/ai-feedback', payload)]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 429]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['invalid-json', 'blank', 'length', 'extra-key', 'not-literal', 'numeric-criterion'])('charges invalid %s without saving a proposal', async kind => {
    const data = output();
    let content = JSON.stringify(data);
    if (kind === 'invalid-json') content = '{';
    if (kind === 'blank') content = '   ';
    if (kind === 'extra-key') content = JSON.stringify({ ...data, extra: true });
    if (kind === 'not-literal') { data.criteriaFeedback[0].answerQuotes = ['Never written']; content = JSON.stringify(data); }
    if (kind === 'numeric-criterion') content = JSON.stringify({ ...data, criteriaFeedback: [{ ...data.criteriaFeedback[0], score: 3 }] });
    const finish = vi.spyOn(SqliteAiStorage.prototype, 'finish');
    const { app, headers, post, payload } = await setup({ DEEPSEEK_API_KEY: fakeKey() }, async () => Response.json(envelope(content, kind === 'length' ? 'length' : 'stop')));
    const before = (await app.inject({ url: '/api/state', headers })).json();
    const result = await post('/ai-feedback', payload);
    expect(result.statusCode).toBe(502);
    expect(result.json().error).toBe('The AI response could not be validated; no feedback was saved. Use manual review.');
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ costMicroUsd: 303,
      request: expect.objectContaining({ status: 'invalid', proposal: null }) }));
    expect((await app.inject({ url: '/api/state', headers })).json().judgments).toEqual(before.judgments);
  });
  it('releases network-failure reservation but counts the request', async () => {
    const finish = vi.spyOn(SqliteAiStorage.prototype, 'finish');
    const { post, payload, fetch } = await setup({ DEEPSEEK_API_KEY: fakeKey(), AI_FEEDBACK_DAILY_REQUEST_CAP: '1' }, async () => { throw new Error('Transport failed'); });
    expect((await post('/ai-feedback', payload)).statusCode).toBe(502);
    expect(finish).toHaveBeenCalledWith(expect.objectContaining({ costMicroUsd: 0 }));
    expect((await post('/ai-feedback', payload)).statusCode).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(['success', '401', '402', '429', '500', 'network', 'timeout', 'invalid-json', 'echo'])('never leaks the fake key on %s', async path => {
    const key = fakeKey();
    const logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
    const { post, payload, fetch } = await setup({ DEEPSEEK_API_KEY: key }, async () => {
      if (path === 'network') throw new Error(key);
      if (path === 'timeout') return new Promise<Response>(() => {});
      if (/^\d+$/.test(path)) return new Response(key, { status: Number(path), headers: { 'x-provider-error': key } });
      if (path === 'invalid-json') return new Response(key);
      if (path === 'echo') return Response.json(envelope(JSON.stringify({ ...output(), reason: key })));
      return Response.json(envelope());
    });
    if (path === 'timeout') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = Promise.resolve(post('/ai-feedback', payload));
    if (path === 'timeout') { await vi.waitFor(() => expect(fetch).toHaveBeenCalled()); await vi.advanceTimersByTimeAsync(50_001); }
    const result = await pending;
    expect(JSON.stringify({ body: result.body, headers: result.headers })).not.toContain(key);
    expect(JSON.stringify(logs.flatMap(log => log.mock.calls))).not.toContain(key);
  });
  it('keeps provider credential names and key prefixes out of web sources', () => {
    function files(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]);
    }
    for (const file of files('apps/web/src')) expect(readFileSync(file, 'utf8')).not.toMatch(/DEEPSEEK|\bsk-/);
  });
});
