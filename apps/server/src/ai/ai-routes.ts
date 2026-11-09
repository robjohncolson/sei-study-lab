import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AiConfig } from './ai-config.js';
import { AiAdapterError, createAiAdapter } from './deepseek-adapter.js';
import { AI_PRIVACY_NOTICE, buildFeedbackRequest, validateFeedbackOutput } from './feedback-request.js';
import { dayEt, estimateCostMicroUsd, usageCostMicroUsd } from './budget.js';
import { AiStorageError, type AiStorage, type AiRequestRecord } from './ai-storage.js';

export type AiServerOptions = { env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch };
const PreviewBody = z.object({ attemptId: z.string().uuid() }).strict();
const RequestBody = PreviewBody.extend({ previewSha256: z.string().regex(/^[a-f0-9]{64}$/), consent: z.literal(true) }).strict();
const ApproveBody = z.object({ requestId: z.string().uuid(), confirm: z.literal(true) }).strict();
const invalidResponse = 'The AI response could not be validated; no feedback was saved. Use manual review.';
const limitReached = 'Daily AI feedback limit reached. Use manual review.';

/** Register inside the app's existing Host, Origin, owner/session and CSRF guards. */
export function registerAiRoutes(app: FastifyInstance, options: {
  config: AiConfig;
  storage: (request: FastifyRequest) => AiStorage;
  local: boolean;
  fetch?: typeof globalThis.fetch;
  clock?: () => Date;
}) {
  const { config } = options;
  const clock = options.clock ?? (() => new Date());
  const adapter = createAiAdapter(config, { fetch: options.fetch, clock });
  const unavailable = `AI feedback is not available (no provider key configured). Use manual review${options.local ? ' or the Grok handoff packet' : ''}`;
  const available = Boolean(config.apiKey) && config.dailyBudgetMicroUsd > 0;
  const safe = (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try { return await handler(request, reply); }
      catch (error) {
        if (error instanceof AiStorageError) return reply.code(error.statusCode).send({ error: error.message });
        if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid AI feedback request' });
        // Never forward database, fetch, JSON parser, or arbitrary exception messages.
        return reply.code(500).send({ error: 'AI feedback could not be completed. Use manual review.' });
      }
    };
  const rebuild = async (storage: AiStorage, attemptId: string) => {
    const stored = await storage.loadAttempt(attemptId);
    if (!stored) throw new AiStorageError(404, 'Writing attempt not found');
    try { return { ...stored, request: buildFeedbackRequest({ ...stored, model: config.model }) }; }
    catch { throw new AiStorageError(400, 'This attempt is not eligible for rubric-anchored writing feedback. Use manual review.'); }
  };

  app.get('/api/ai-feedback/status', safe(async request => {
    // A missing provider needs no database work, including on an unmigrated host.
    const usage = available ? await options.storage(request).usage(dayEt(clock())) : null;
    return {
      available, ...(!available ? { reason: config.apiKey ? 'AI feedback is disabled by the daily budget. Use manual review.' : unavailable } : {}),
      provider: 'DeepSeek', model: config.model, dailyBudgetUsd: config.dailyBudgetUsd,
      spentUsdToday: Number(((usage?.spentMicroUsd ?? 0) / 1_000_000).toFixed(2)),
      reservedUsdToday: Number(((usage?.reservedMicroUsd ?? 0) / 1_000_000).toFixed(2)),
      remainingRequestsToday: available ? Math.max(0, config.dailyRequestCap - (usage?.requests ?? 0)) : 0,
      privacyNotice: AI_PRIVACY_NOTICE,
    };
  }));
  app.post('/api/ai-feedback/preview', safe(async request => {
    const body = PreviewBody.parse(request.body);
    const { request: preview } = await rebuild(options.storage(request), body.attemptId);
    return { available, model: config.model, previewSha256: preview.previewSha256,
      sentData: preview.sentData, privacyNotice: AI_PRIVACY_NOTICE };
  }));
  app.post('/api/ai-feedback', {
    // Node's requestTimeout covers receiving the request. Extend the socket's idle
    // timeout for this route's bounded 50-second provider operation when listening.
    onRequest: async (request, reply) => { try { if (typeof request.raw.socket?.setTimeout === 'function') { request.raw.setTimeout?.(60_000); reply.raw.setTimeout?.(60_000); } } catch { /* Best-effort when listening; serverless platforms enforce their own duration. */ } },
  }, safe(async (request, reply) => {
    if (!request.body || typeof request.body !== 'object' || !('consent' in request.body) || request.body.consent !== true) {
      return reply.code(400).send({ error: 'Explicit consent is required for each request' });
    }
    const body = RequestBody.parse(request.body);
    if (!config.apiKey) return reply.code(501).send({ available: false, error: unavailable });
    if (config.dailyBudgetMicroUsd === 0) return reply.code(429).send({ error: limitReached });
    const storage = options.storage(request);
    const { attempt, task, request: preview } = await rebuild(storage, body.attemptId);
    if (preview.previewSha256 !== body.previewSha256) return reply.code(409).send({ error: 'The preview changed. Review a fresh preview and consent again.' });
    const day = dayEt(clock());
    const reservedMicroUsd = estimateCostMicroUsd(preview.messages, config);
    if (!await storage.reserve(day, reservedMicroUsd, config.dailyBudgetMicroUsd, config.dailyRequestCap)) {
      return reply.code(429).send({ error: limitReached });
    }
    const id = randomUUID();
    let costMicroUsd = reservedMicroUsd, inputTokens = 0, outputTokens = 0, retainReservation = true;
    let status: AiRequestRecord['status'] = 'failed';
    let proposal: AiRequestRecord['proposal'] = null;
    let responseCode = 502, errorMessage = invalidResponse;
    try {
      const response = await adapter.complete(preview.messages);
      if (response.usage) {
        retainReservation = false;
        costMicroUsd = usageCostMicroUsd(response.usage, config);
        inputTokens = response.usage.promptTokens;
        outputTokens = response.usage.completionTokens;
      }
      // Mark invalid before parsing so every rejected output is recorded and charged.
      status = 'invalid';
      proposal = validateFeedbackOutput(response.content, { requestId: id, attempt, task, request: preview, model: config.model });
      status = 'validated';
    } catch (error) {
      if (error instanceof AiAdapterError) {
        if (!error.responseReceived) { costMicroUsd = 0; retainReservation = false; }
        else if (error.usage) {
          retainReservation = false;
          costMicroUsd = usageCostMicroUsd(error.usage, config);
          inputTokens = error.usage.promptTokens;
          outputTokens = error.usage.completionTokens;
        }
        status = error.kind === 'invalid' ? 'invalid' : 'failed';
        responseCode = error.statusCode;
        errorMessage = error.kind === 'invalid' ? invalidResponse : error.message;
      }
    }
    await storage.finish({ day, reservedMicroUsd, costMicroUsd, inputTokens, outputTokens, retainReservation,
      request: { id, attemptId: attempt.id, previewSha256: preview.previewSha256, model: config.model,
        status, proposal, costMicroUsd, createdAt: clock().toISOString() } });
    if (!proposal) return reply.code(responseCode).send({ error: errorMessage });
    return { requestId: id, proposal, warning: 'Provisional AI draft. Not an official MTEL score. Review before saving.' };
  }));
  app.post('/api/ai-feedback/approve', safe(async request => {
    const body = ApproveBody.parse(request.body);
    return options.storage(request).approve(body.requestId);
  }));
}
