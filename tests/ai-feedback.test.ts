import { randomUUID } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import bundledCatalog from '../content/catalog.json';
import { CatalogSchema } from '../packages/shared/src/index.js';
import { readAiConfig } from '../apps/server/src/ai/ai-config.js';
import { dayEt, estimateCostMicroUsd, parseAiUsage, usageCostMicroUsd } from '../apps/server/src/ai/budget.js';
import { AiAdapterError, createAiAdapter, NullAdapter } from '../apps/server/src/ai/deepseek-adapter.js';
import { AI_INVALID_RESPONSE, AI_PRIVACY_NOTICE, buildFeedbackRequest, validateFeedbackOutput } from '../apps/server/src/ai/feedback-request.js';
import type { Attempt } from '../apps/server/src/types.js';

const catalog = CatalogSchema.parse(bundledCatalog);
const task = catalog.tasks.find(item => item.kind === 'writing')!;
const mentor = catalog.mentorTexts.find(item => item.id === task.mentorTextId)!;
const attempt: Attempt = {
  id: randomUUID(), taskId: task.id, taskVersion: task.version, sessionId: 'DO-NOT-SEND-SESSION',
  originalAnswer: { mentorTextId: mentor.id, mentorTextVersion: mentor.version, mentorTextHash: mentor.sha256,
    startedAt: 'DO-NOT-SEND-TIMESTAMP', assistance: ['DO-NOT-SEND-HINT'], plannedMinutes: 60,
    parts: Object.fromEntries(task.parts!.map(part => [part.id, 'I would use oral rehearsal before writing.'])) },
  startedAt: '2026-11-09T12:00:00.000Z', submittedAt: '2026-11-09T12:01:00.000Z',
  hintCount: 3, assistance: ['DO-NOT-SEND-HINT'], exposureGroupId: task.familyId,
  noveltyKind: task.noveltyKind, parentAttemptId: null, mentorText: { id: mentor.id, version: mentor.version, sha256: mentor.sha256 },
};
const requestFor = (stored = attempt, model = 'deepseek-flash') => buildFeedbackRequest({ task, attempt: stored, mentorTexts: catalog.mentorTexts, rubrics: catalog.rubrics, model });
const outputFor = () => ({ criteriaFeedback: requestFor().rubric.criteria.map(criterion => ({ criterionId: criterion.id,
  comment: 'Diagnostic comment only.', answerQuotes: ['oral rehearsal'], missingEvidence: ['More justification.'] })), holisticScore: 3,
  needsHumanReview: true, reason: 'An unofficial provisional assessment.' });
const validate = (value: unknown, stored = attempt) => validateFeedbackOutput(typeof value === 'string' ? value : JSON.stringify(value),
  { requestId: randomUUID(), attempt: stored, task, request: requestFor(stored), model: 'deepseek-flash' });
const usage = { prompt_tokens: 1000, prompt_cache_hit_tokens: 100, prompt_cache_miss_tokens: 900, completion_tokens: 200 };
const envelope = (content = JSON.stringify(outputFor()), finish_reason = 'stop') => ({ choices: [{ message: { content }, finish_reason }], usage });
const fakeKey = () => `sk-test-NOT-A-REAL-KEY-${randomUUID()}`;
const configured = (key = fakeKey()) => readAiConfig({ DEEPSEEK_API_KEY: key });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('server-only AI configuration', () => {
  it('defaults to Flash, peak prices and an unavailable null adapter without a key', async () => {
    expect(readAiConfig({})).toMatchObject({ apiKey: null, model: 'deepseek-flash', dailyBudgetUsd: 2,
      dailyBudgetMicroUsd: 2_000_000, dailyRequestCap: 60, priceInputMissPerM: 0.30, priceInputHitPerM: 0.006,
      priceOutputPerM: 1.20, maxOutputTokens: 1800 });
    const fetch = vi.fn();
    expect(createAiAdapter(readAiConfig({ DEEPSEEK_API_KEY: '  ' }), { fetch })).toBeInstanceOf(NullAdapter);
    await expect(createAiAdapter(readAiConfig({}), { fetch }).complete(requestFor().messages)).rejects.toMatchObject({ statusCode: 501 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ['AI_FEEDBACK_MODEL', 'untrusted-model'], ['AI_FEEDBACK_MODEL', 'deepseek-flash\n'],
    ['AI_FEEDBACK_MODEL', `deepseek-${'a'.repeat(65)}`],
    ['AI_FEEDBACK_DAILY_BUDGET_USD', '-1'], ['AI_FEEDBACK_DAILY_BUDGET_USD', '50.01'],
    ['AI_FEEDBACK_DAILY_REQUEST_CAP', '0'], ['AI_FEEDBACK_DAILY_REQUEST_CAP', '1001'], ['AI_FEEDBACK_DAILY_REQUEST_CAP', '1.1'],
    ['AI_FEEDBACK_PRICE_INPUT_MISS_PER_M', 'NaN'], ['AI_FEEDBACK_PRICE_INPUT_HIT_PER_M', '-1'],
    ['AI_FEEDBACK_PRICE_OUTPUT_PER_M', 'Infinity'], ['AI_FEEDBACK_MAX_OUTPUT_TOKENS', '0'], ['AI_FEEDBACK_MAX_OUTPUT_TOKENS', '1.1'],
  ])('reports only the invalid setting %s', (name, value) => {
    let message = '';
    try { readAiConfig({ [name]: value }); } catch (error) { message = (error as Error).message; }
    expect(message).toBe(name);
  });
  it('accepts disabling the budget and explicit price/model overrides', () => {
    expect(readAiConfig({ AI_FEEDBACK_DAILY_BUDGET_USD: '0', AI_FEEDBACK_MODEL: 'deepseek-v4-pro',
      AI_FEEDBACK_PRICE_INPUT_HIT_PER_M: '0.01', AI_FEEDBACK_MAX_OUTPUT_TOKENS: '2000' })).toMatchObject({
      dailyBudgetMicroUsd: 0, model: 'deepseek-v4-pro', priceInputHitPerM: 0.01, maxOutputTokens: 2000,
    });
  });
});

describe('minimal stored-data request and strict rubric output', () => {
  it('sends only allowlisted task, bound mentor, verbatim rubric and original answer parts', () => {
    const request = requestFor(), data = JSON.parse(request.messages[1].content);
    expect(data).toEqual(request.sentData);
    expect(Object.keys(data).sort()).toEqual(['answer', 'mentor', 'rubric', 'task']);
    expect(Object.keys(data.task).sort()).toEqual(['parts', 'prompt', 'title']);
    expect(Object.keys(data.mentor).sort()).toEqual(['text', 'title']);
    expect(Object.keys(data.answer)).toEqual(['parts']);
    expect(data.rubric.criteria).toEqual(request.rubric.criteria);
    expect(data.rubric.scale).toEqual(request.rubric.scale);
    for (const forbidden of [attempt.id, attempt.sessionId, attempt.startedAt, attempt.submittedAt, 'DO-NOT-SEND-HINT', 'DO-NOT-SEND-TIMESTAMP', 'ownerId', 'attemptId', 'hintCount']) {
      expect(JSON.stringify(request.messages)).not.toContain(forbidden);
    }
    expect(request.messages[0].content).toContain('json');
    expect(request.messages[0].content).toContain('U/B');
    expect(request.messages[0].content).toContain('Subject Matter Knowledge');
    expect(requestFor().previewSha256).toBe(request.previewSha256);
    expect(requestFor(attempt, 'deepseek-v4-pro').previewSha256).not.toBe(request.previewSha256);
    expect(AI_PRIVACY_NOTICE).toContain("People's Republic of China");
  });
  it('rejects non-writing tasks and other rubric versions', () => {
    for (const changed of [{ ...task, kind: 'short' as const }, { ...task, rubricVersionId: undefined }, { ...task, rubricVersionId: 'rubric.mtel56.public@2' }]) {
      expect(() => buildFeedbackRequest({ task: changed, attempt, mentorTexts: catalog.mentorTexts, rubrics: catalog.rubrics, model: 'deepseek-flash' })).toThrow();
    }
  });
  it('never substitutes another mentor and requires review for mismatches or missing parts', () => {
    const changed = { ...attempt, mentorText: { ...attempt.mentorText!, sha256: '0'.repeat(64) } };
    expect(requestFor(changed)).toMatchObject({ sentData: { mentor: null }, requiresHumanReview: true });
    const missing = { ...attempt, originalAnswer: { parts: {} } };
    const proposal = validate({ ...outputFor(), needsHumanReview: false, criteriaFeedback: outputFor().criteriaFeedback.map(item => ({ ...item, answerQuotes: [] })) }, missing);
    expect(proposal.needsHumanReview).toBe(true);
  });
  it('assembles server identities, one holistic score, and no evidence', () => {
    expect(validate(outputFor())).toMatchObject({ schemaVersion: 1, attemptId: attempt.id, taskVersion: task.version,
      rubricVersion: 'rubric.mtel56.public@1', judgeLabel: 'AI draft (DeepSeek deepseek-flash), unofficial',
      provisional: true, holisticScore: 3, proposedEvidence: [] });
    for (const holisticScore of [1, 2, 3, 4, 'U', 'B', null]) expect(validate({ ...outputFor(), holisticScore }).holisticScore).toBe(holisticScore);
  });
  it('rejects extra keys, per-criterion numbers, duplicate/unknown criteria, and fabricated or metadata quotations', () => {
    const out = outputFor();
    const invalid = [
      { ...out, attemptId: 'model-supplied' }, { ...out, confidence: 0.9 },
      { ...out, criteriaFeedback: out.criteriaFeedback.map(item => ({ ...item, score: 4 })) },
      { ...out, criteriaFeedback: out.criteriaFeedback.map(item => ({ ...item, criterionId: 'invented' })) },
      { ...out, criteriaFeedback: out.criteriaFeedback.map(item => ({ ...item, criterionId: 'purpose' })) },
      { ...out, criteriaFeedback: out.criteriaFeedback.map(item => ({ ...item, answerQuotes: ['invented quote'] })) },
      { ...out, criteriaFeedback: out.criteriaFeedback.map(item => ({ ...item, answerQuotes: ['DO-NOT-SEND-HINT'] })) },
      { ...out, criteriaFeedback: out.criteriaFeedback.map(item => ({ ...item, answerQuotes: ['writing.\nI would'] })) },
      '', '   ', '{',
    ];
    for (const value of invalid) expect(() => validate(value)).toThrow(AI_INVALID_RESPONSE);
  });
  it('rejects NUL and lone surrogates before Postgres jsonb persistence, while accepting paired Unicode', () => {
    for (const invalidText of ['nul\u0000text', 'high\ud800', '\udfff low', '\ud800\ud800\udfff']) {
      expect(() => validate({ ...outputFor(), reason: invalidText })).toThrow(AI_INVALID_RESPONSE);
      expect(() => validate({ ...outputFor(), criteriaFeedback: outputFor().criteriaFeedback.map(item => ({ ...item, comment: invalidText })) })).toThrow(AI_INVALID_RESPONSE);
      expect(() => validate({ ...outputFor(), criteriaFeedback: outputFor().criteriaFeedback.map(item => ({ ...item, missingEvidence: [invalidText] })) })).toThrow(AI_INVALID_RESPONSE);
    }
    expect(validate({ ...outputFor(), reason: 'Review \ud83d\udcdd' }).reason).toBe('Review 📝');
  });
});

describe('integer micro-dollar costs and New York days', () => {
  it('rounds conservatively and distinguishes cached input from misses', () => {
    const config = configured(), parsed = parseAiUsage(usage)!;
    expect(usageCostMicroUsd(parsed, config)).toBe(511);
    const messages = requestFor().messages;
    expect(estimateCostMicroUsd(messages, config)).toBe(Math.ceil(Math.ceil(JSON.stringify(messages).length / 3) * 0.30 + 1800 * 1.20));
    expect(parseAiUsage({ prompt_tokens: 2, completion_tokens: 3 })).toEqual({ promptTokens: 2, cacheHitTokens: 0, cacheMissTokens: 2, completionTokens: 3 });
    expect(parseAiUsage({ ...usage, prompt_cache_hit_tokens: 999 })).toBeNull();
    expect(parseAiUsage({ prompt_tokens: -1, completion_tokens: 1 })).toBeNull();
    expect(parseAiUsage(null)).toBeNull();
  });
  it.each([
    ['2026-11-09T04:59:00Z', '2026-11-08'], ['2026-11-09T05:01:00Z', '2026-11-09'],
    ['2026-06-01T03:59:00Z', '2026-05-31'], ['2026-06-01T04:01:00Z', '2026-06-01'],
    ['2026-03-08T06:59:00Z', '2026-03-08'], ['2026-03-08T07:01:00Z', '2026-03-08'],
    ['2026-11-01T05:59:00Z', '2026-11-01'], ['2026-11-01T06:01:00Z', '2026-11-01'],
  ])('maps %s to the owner day %s', (instant, day) => expect(dayEt(new Date(instant))).toBe(day));
});

describe('mock-only DeepSeek HTTP boundary and secret containment', () => {
  it('uses only the fixed URL, authorized header, JSON mode, disabled thinking and bounded output', async () => {
    const key = fakeKey(), config = configured(key), fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(envelope()));
    const result = await createAiAdapter(config, { fetch }).complete(requestFor().messages);
    expect(result.usage).toEqual(parseAiUsage(usage));
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { Authorization: `Bearer ${key}` } });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init?.body))).toEqual({ model: 'deepseek-flash', messages: requestFor().messages,
      response_format: { type: 'json_object' }, thinking: { type: 'disabled' }, max_tokens: 1800 });
    expect(String(init?.body)).not.toContain(key);
    expect(JSON.stringify(result)).not.toContain(key);
  });
  it.each([401, 402, 429, 500, 503])('sanitizes HTTP %i without reading its error body', async status => {
    const key = fakeKey(), response = new Response(key, { status }), json = vi.spyOn(response, 'json');
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
    const consoleSpies = ['log', 'warn', 'error', 'info', 'debug'].map(method => vi.spyOn(console, method as 'log').mockImplementation(() => {}));
    const error = await createAiAdapter(configured(key), { fetch }).complete(requestFor().messages).then(() => { throw new Error('Expected failure'); }, error => error as AiAdapterError);
    expect(error).toBeInstanceOf(AiAdapterError);
    expect(error.responseReceived).toBe(true);
    expect(error.message).not.toContain(key);
    expect(json).not.toHaveBeenCalled();
    for (const spy of consoleSpies) expect(JSON.stringify(spy.mock.calls)).not.toContain(key);
  });
  it.each([' ', '', '{invalid json'])('rejects invalid content %j while preserving billed usage', async content => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(envelope(content)));
    await expect(createAiAdapter(configured(), { fetch }).complete(requestFor().messages)).rejects.toMatchObject({
      kind: 'invalid', message: AI_INVALID_RESPONSE, responseReceived: true, usage: parseAiUsage(usage),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('rejects length-truncated content, malformed envelopes and echoed keys including JSON escapes', async () => {
    const key = fakeKey();
    const echoed = JSON.stringify({ ...outputFor(), reason: key });
    for (const body of [envelope(JSON.stringify(outputFor()), 'length'), {}, envelope(echoed), envelope(echoed.replace('sk-test-', '\\u0073k-test-'))]) {
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(Response.json(body));
      const error = await createAiAdapter(configured(key), { fetch }).complete(requestFor().messages).then(() => { throw new Error('Expected failure'); }, error => error as AiAdapterError);
      expect(error.message).toBe(AI_INVALID_RESPONSE);
      expect(JSON.stringify(error)).not.toContain(key);
    }
  });
  it('sanitizes network exceptions and times out after 50 seconds with cancellation', async () => {
    const key = fakeKey();
    const failure = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error(key));
    await expect(createAiAdapter(configured(key), { fetch: failure }).complete(requestFor().messages)).rejects.toMatchObject({
      message: 'AI feedback could not reach the provider. Use manual review.', responseReceived: false,
    });
    vi.useFakeTimers();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => {}));
    const result = createAiAdapter(configured(key), { fetch }).complete(requestFor().messages).then(() => { throw new Error('Expected failure'); }, error => error as AiAdapterError);
    await vi.advanceTimersByTimeAsync(50_000);
    const error = await result;
    expect(error).toMatchObject({ statusCode: 504, responseReceived: false });
    expect(error.message).not.toContain(key);
    expect(fetch.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });
  it('keeps provider environment names and key-shaped text out of all web source files', () => {
    const walk = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap(entry =>
      entry.isDirectory() ? walk(resolve(directory, entry.name)) : [resolve(directory, entry.name)]);
    for (const file of walk(resolve('apps/web/src'))) expect(readFileSync(file, 'utf8')).not.toMatch(/DEEPSEEK|\bsk-/);
  });
});
