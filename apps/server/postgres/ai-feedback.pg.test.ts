import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { CatalogSchema } from '../../../packages/shared/src/index.js';
import content from '../../../content/catalog.json' with { type: 'json' };
import { PostgresAiStorage } from '../src/ai/postgres-ai-storage.js';
import type { AiProposal, AiRequestRecord } from '../src/ai/ai-storage.js';
import { PostgresStudyStore } from '../src/postgres/study-store.js';
import { withOwnerTransaction } from '../src/postgres/transaction.js';
import { createHostedSeiServer } from '../src/hosted-app.js';
import { readHostedConfig } from '../src/hosted-config.js';
import { createPostgresHarness, type PostgresHarness } from './harness.js';

const catalog = CatalogSchema.parse(content);
const now = () => new Date('2026-11-09T17:00:00.000Z');
const day = '2026-11-09';

describe('AI accounting and approval on disposable real Postgres', () => {
  let harness: PostgresHarness;
  const apps: FastifyInstance[] = [];
  beforeAll(async () => { harness = await createPostgresHarness(); });
  afterAll(async () => { await Promise.all(apps.map(app => app.close())); if (harness) await harness.dispose(); });

  async function setup() {
    const owner = randomUUID(), claims = { sub: owner, role: 'authenticated' as const };
    const task = catalog.tasks.find(item => item.kind === 'writing')!;
    const mentor = catalog.mentorTexts.find(item => item.id === task.mentorTextId)!;
    const submitted = await withOwnerTransaction(harness.pool, claims, client => new PostgresStudyStore(client, owner, catalog, now).submit({
      taskId: task.id, taskVersion: task.version, hintCount: 0, assistance: [],
      answer: { mentorTextId: mentor.id, mentorTextVersion: mentor.version, mentorTextHash: mentor.sha256,
        rubricVersionId: task.rubricVersionId, parts: Object.fromEntries(task.parts!.map(part => [part.id, 'A synthetic explanation with literal evidence.'])) },
    }, 'synthetic-session'));
    const storage = new PostgresAiStorage(harness.pool, claims, catalog, now);
    const record = (status: AiRequestRecord['status'] = 'validated'): AiRequestRecord => {
      const id = randomUUID();
      const rubric = catalog.rubrics.find(item => `${item.id}@${item.version}` === task.rubricVersionId)!;
      const proposal: AiProposal = { schemaVersion: 1, packetId: id, attemptId: submitted.attempt.id, taskVersion: task.version,
        rubricVersion: task.rubricVersionId!, judgeLabel: 'AI draft (DeepSeek deepseek-flash), unofficial', provisional: true,
        criteriaFeedback: rubric.criteria.map(item => ({ criterionId: item.id, comment: 'Synthetic diagnostic comment',
          answerQuotes: ['literal evidence'], missingEvidence: [] })), holisticScore: 2, needsHumanReview: true,
        reason: 'Synthetic provisional review', proposedEvidence: [] };
      return { id, attemptId: submitted.attempt.id, previewSha256: 'a'.repeat(64), model: 'deepseek-flash', status,
        proposal: status === 'validated' ? proposal : null, costMicroUsd: 100, createdAt: now().toISOString() };
    };
    return { owner, claims, storage, submitted, record };
  }

  async function routes(env: NodeJS.ProcessEnv = {}) {
    const saved = await setup();
    const config = readHostedConfig({ STORAGE_MODE: 'postgres', HOSTED_AUTH_MODE: 'public', PUBLIC_OWNER_ID: saved.owner,
      SEI_DATABASE_URL: harness.appUrl, APP_ORIGINS: 'https://synthetic-ai.example', APP_HOSTS: 'synthetic-ai.example' });
    const proposal = saved.record().proposal!;
    const modelPart = { criteriaFeedback: proposal.criteriaFeedback, holisticScore: proposal.holisticScore,
      needsHumanReview: true, reason: proposal.reason };
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: JSON.stringify(modelPart) }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 10 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const app = await createHostedSeiServer({ config, pool: harness.pool, catalog, clock: now, ai: { env, fetch: fetchMock } });
    apps.push(app);
    const session = await app.inject({ url: '/api/session', headers: { host: 'synthetic-ai.example' } });
    const headers = { host: 'synthetic-ai.example', origin: 'https://synthetic-ai.example', 'x-csrf-token': session.json().csrfToken as string };
    const post = (path: string, payload: unknown) => app.inject({ method: 'POST', url: `/api/ai-feedback${path}`, headers, payload: payload as object });
    return { ...saved, app, headers, post, fetchMock };
  }

  it('serves public hosted AI routes with no-key, consent and preview-hash guards before any fetch', async () => {
    const missing = await routes();
    expect((await missing.app.inject({ url: '/api/ai-feedback/status', headers: missing.headers })).json()).toMatchObject({ available: false, provider: 'DeepSeek' });
    const attemptId = missing.submitted.attempt.id;
    const preview = await missing.post('/preview', { attemptId });
    expect(preview.statusCode).toBe(200);
    for (const consent of [undefined, false]) {
      const response = await missing.post('', { attemptId, previewSha256: preview.json().previewSha256, consent });
      expect(response.statusCode).toBe(400);
      expect(response.json().error).toBe('Explicit consent is required for each request');
    }
    expect((await missing.post('', { attemptId, previewSha256: preview.json().previewSha256, consent: true })).statusCode).toBe(501);
    expect(missing.fetchMock).not.toHaveBeenCalled();
    const available = await routes({ DEEPSEEK_API_KEY: `sk-test-NOT-A-REAL-KEY-${randomUUID()}` });
    expect((await available.post('', { attemptId: available.submitted.attempt.id, previewSha256: '0'.repeat(64), consent: true })).statusCode).toBe(409);
    expect(available.fetchMock).not.toHaveBeenCalled();
  });

  it('caps parallel hosted requests, reconciles usage, approves once, and rejects foreign request IDs', async () => {
    const owned = await routes({ DEEPSEEK_API_KEY: `sk-test-NOT-A-REAL-KEY-${randomUUID()}`, AI_FEEDBACK_DAILY_REQUEST_CAP: '1' });
    const attemptId = owned.submitted.attempt.id;
    const preview = (await owned.post('/preview', { attemptId })).json();
    const results = await Promise.all([owned.post('', { attemptId, previewSha256: preview.previewSha256, consent: true }),
      owned.post('', { attemptId, previewSha256: preview.previewSha256, consent: true })]);
    expect(results.map(result => result.statusCode).sort()).toEqual([200, 429]);
    expect(owned.fetchMock).toHaveBeenCalledTimes(1);
    expect(await owned.storage.usage(day)).toMatchObject({ requests: 1, reservedMicroUsd: 0, spentMicroUsd: 42, inputTokens: 100, outputTokens: 10 });
    const success = results.find(result => result.statusCode === 200)!.json();
    expect(success.proposal).toMatchObject({ provisional: true, proposedEvidence: [] });
    const approved = await owned.post('/approve', { requestId: success.requestId, confirm: true });
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({ duplicate: false, evidenceEvents: [], judgment: { judgeKind: 'ai_approved_proposal', result: { provisional: true, sourceChecked: false, status: 'needs_review' } } });
    expect((await owned.post('/approve', { requestId: success.requestId, confirm: true })).json().duplicate).toBe(true);
    const other = await routes();
    expect((await other.post('/approve', { requestId: success.requestId, confirm: true })).statusCode).toBe(404);
    expect((await other.post('/preview', { attemptId })).statusCode).toBe(404);
  });

  it('charges invalid hosted model output without saving a proposal or raw output', async () => {
    const owned = await routes({ DEEPSEEK_API_KEY: `sk-test-NOT-A-REAL-KEY-${randomUUID()}` });
    owned.fetchMock.mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: 'not model json' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 100, completion_tokens: 10 },
    }), { status: 200 }));
    const attemptId = owned.submitted.attempt.id;
    const preview = (await owned.post('/preview', { attemptId })).json();
    const response = await owned.post('', { attemptId, previewSha256: preview.previewSha256, consent: true });
    expect(response.statusCode).toBe(502);
    expect(response.json().error).toBe('The AI response could not be validated; no feedback was saved. Use manual review.');
    expect(await owned.storage.usage(day)).toMatchObject({ spentMicroUsd: 42, requests: 1, reservedMicroUsd: 0 });
    const rows = await withOwnerTransaction(harness.pool, owned.claims, client => client.query('SELECT * FROM sei.ai_feedback_requests WHERE owner_id=$1', [owned.owner]));
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ status: 'invalid', proposal_json: null });
    expect(JSON.stringify(rows.rows)).not.toContain('not model json');
  });

  it('serializes parallel owner reservations and commits the cap before HTTP can run', async () => {
    const { storage } = await setup();
    const results = await Promise.all(Array.from({ length: 12 }, () => storage.reserve(day, 400, 1000, 100)));
    expect(results.filter(Boolean)).toHaveLength(2);
    expect(await storage.usage(day)).toMatchObject({ requests: 2, reservedMicroUsd: 800, spentMicroUsd: 0 });
    expect(await storage.reserve(day, 1, 10000, 2)).toBe(false);
  });

  it('reconciles actual usage once, charges invalid output, and releases failed transport without refunding requests', async () => {
    const { storage, record } = await setup();
    expect(await storage.reserve(day, 1000, 10000, 10)).toBe(true);
    const invalid = record('invalid');
    const finished = { day, reservedMicroUsd: 1000, costMicroUsd: 100, inputTokens: 100, outputTokens: 20, request: invalid };
    await storage.finish(finished);
    await storage.finish(finished);
    expect(await storage.usage(day)).toEqual({ requests: 1, reservedMicroUsd: 0, spentMicroUsd: 100, inputTokens: 100, outputTokens: 20 });
    await expect(storage.approve(invalid.id)).rejects.toMatchObject({ statusCode: 404 });
    expect(await storage.reserve(day, 1000, 10000, 10)).toBe(true);
    await storage.finish({ day, reservedMicroUsd: 1000, costMicroUsd: 0, inputTokens: 0, outputTokens: 0, request: { ...record('failed'), costMicroUsd: 0 } });
    expect(await storage.usage(day)).toMatchObject({ requests: 2, reservedMicroUsd: 0, spentMicroUsd: 100 });
    expect(await storage.reserve(day, 1000, 10000, 10)).toBe(true);
    await storage.finish({ day, reservedMicroUsd: 1000, costMicroUsd: 1000, inputTokens: 0, outputTokens: 0,
      retainReservation: true, request: { ...record('invalid'), costMicroUsd: 1000 } });
    expect(await storage.usage(day)).toMatchObject({ requests: 3, reservedMicroUsd: 1000, spentMicroUsd: 100 });
  });

  it('settles flashcard usage only in the owning ledger without request history', async () => {
    const { owner, claims, storage } = await setup();
    const foreign = new PostgresAiStorage(harness.pool, { sub: randomUUID(), role: 'authenticated' }, catalog, now);
    expect(await storage.reserve(day, 1000, 1_500_000, 50)).toBe(true);
    await expect(foreign.settleUsage({ day, reservedMicroUsd: 1000, costMicroUsd: 42, inputTokens: 100, outputTokens: 10 }))
      .rejects.toMatchObject({ statusCode: 500, message: 'AI feedback accounting could not be completed.' });
    expect(await storage.usage(day)).toMatchObject({ requests: 1, reservedMicroUsd: 1000, spentMicroUsd: 0 });
    await storage.settleUsage({ day, reservedMicroUsd: 1000, costMicroUsd: 42, inputTokens: 100, outputTokens: 10 });
    expect(await storage.usage(day)).toEqual({ requests: 1, reservedMicroUsd: 0, spentMicroUsd: 42, inputTokens: 100, outputTokens: 10 });
    expect(await foreign.usage(day)).toEqual({ requests: 0, reservedMicroUsd: 0, spentMicroUsd: 0, inputTokens: 0, outputTokens: 0 });
    await withOwnerTransaction(harness.pool, claims, async client => {
      expect((await client.query('SELECT * FROM sei.ai_feedback_requests WHERE owner_id=$1', [owner])).rows).toEqual([]);
    });
    expect(await storage.reserve(day, 1000, 1_500_000, 50)).toBe(true);
    await storage.settleUsage({ day, reservedMicroUsd: 1000, costMicroUsd: 1000, inputTokens: 0, outputTokens: 0, retainReservation: true });
    expect(await storage.usage(day)).toMatchObject({ requests: 2, reservedMicroUsd: 1000, spentMicroUsd: 42 });
  });

  it('appends one provisional judgment on concurrent approval, no evidence, with owner isolation', async () => {
    const { owner, claims, storage, record, submitted } = await setup();
    const request = record();
    await storage.reserve(day, 1000, 10000, 10);
    await storage.finish({ day, reservedMicroUsd: 1000, costMicroUsd: 100, inputTokens: 20, outputTokens: 10, request });
    const before = await withOwnerTransaction(harness.pool, claims, client => new PostgresStudyStore(client, owner, catalog, now).state());
    const approved = await Promise.all([storage.approve(request.id), storage.approve(request.id)]);
    expect(approved.filter(item => item.duplicate)).toHaveLength(1);
    for (const approval of approved) {
      expect(approval.evidenceEvents).toEqual([]);
      expect(approval.judgment).toMatchObject({ id: request.id, attemptId: submitted.attempt.id, judgeKind: 'ai_approved_proposal',
        result: { status: 'needs_review', provisional: true, sourceChecked: false } });
    }
    const after = await withOwnerTransaction(harness.pool, claims, client => new PostgresStudyStore(client, owner, catalog, now).state());
    expect(after.judgments).toHaveLength(before.judgments.length + 1);
    expect(after.evidenceEvents).toEqual(before.evidenceEvents);
    expect(after.attempts).toEqual(before.attempts);
    const foreignClaims = { sub: randomUUID(), role: 'authenticated' as const };
    const foreign = new PostgresAiStorage(harness.pool, foreignClaims, catalog, now);
    expect(await foreign.loadAttempt(submitted.attempt.id)).toBeNull();
    await expect(foreign.approve(request.id)).rejects.toMatchObject({ statusCode: 404 });
    await withOwnerTransaction(harness.pool, foreignClaims, async client => {
      expect((await client.query('SELECT * FROM sei.ai_feedback_requests WHERE id=$1', [request.id])).rows).toEqual([]);
      expect((await client.query('SELECT * FROM sei.ai_feedback_usage WHERE owner_id=$1', [owner])).rows).toEqual([]);
    });
  });

  it('applies 003 twice after 000–002, forces RLS, and denies DELETE/TRUNCATE and request UPDATE to sei_app', async () => {
    // The shared harness runs the complete ordered migration sequence twice.
    const { claims } = await setup();
    const security = await harness.database.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      "SELECT relname,relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid IN ('sei.ai_feedback_usage'::regclass,'sei.ai_feedback_requests'::regclass)");
    expect(security.rows).toHaveLength(2);
    expect(security.rows.every(row => row.relrowsecurity && row.relforcerowsecurity)).toBe(true);
    for (const table of ['ai_feedback_usage', 'ai_feedback_requests']) {
      for (const verb of ['DELETE FROM', 'TRUNCATE']) {
        await expect(withOwnerTransaction(harness.pool, claims, client => client.query(`${verb} sei.${table}`))).rejects.toMatchObject({ code: '42501' });
      }
    }
    await expect(withOwnerTransaction(harness.pool, claims, client => client.query("UPDATE sei.ai_feedback_requests SET model='deepseek-flash'"))).rejects.toMatchObject({ code: '42501' });
  });
});
