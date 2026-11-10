import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Catalog } from '../../../../packages/shared/src/index.js';
import { exactRecallMatch, isBlankRecall, FLASHCARD_AI_PRIVACY_NOTICE } from '../../../../packages/shared/src/flashcard-grade.js';
import { nativeContentVersion } from '../native-scheduler.js';
import type { AiConfig } from './ai-config.js';
import { AiStorageError, type AiStorage } from './ai-storage.js';
import { dayEt, estimateCostMicroUsd, usageCostMicroUsd } from './budget.js';
import { AiAdapterError, createAiAdapter } from './deepseek-adapter.js';
import { buildFlashcardGradeRequest, validateFlashcardGradeOutput, FlashcardGradeRequestError,
  FLASHCARD_ESSAY_REQUEST_RESERVE, FLASHCARD_INVALID_OUTPUT, FLASHCARD_MAX_OUTPUT_TOKENS } from './flashcard-grade.js';

const PreviewBody = z.object({ cardId: z.string().min(1).max(200), cardFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  response: z.string().refine(value => value.trim().length >= 1 && value.trim().length <= 4000 && !isBlankRecall(value)),
}).strict();
const GradeBody = PreviewBody.extend({ previewSha256: z.string().regex(/^[a-f0-9]{64}$/), consent: z.literal(true) }).strict();
const limitReached = 'Daily AI grading limit reached. Choose a rating yourself.';
const unavailable = 'AI checking is unavailable (no provider key configured). Choose a rating yourself.';

/** Uses the same app-level Host/Origin/CSRF and signed-in owner guards as essays. */
export function registerFlashcardGradeRoutes(app: FastifyInstance, options: {
  config: AiConfig; catalog: Catalog; storage: (request: FastifyRequest) => AiStorage;
  fetch?: typeof globalThis.fetch; clock?: () => Date;
}) {
  const config = { ...options.config, maxOutputTokens: FLASHCARD_MAX_OUTPUT_TOKENS };
  const clock = options.clock ?? (() => new Date());
  const adapter = createAiAdapter(config, { fetch: options.fetch, clock });
  const requestCeiling = Math.max(1, config.dailyRequestCap - FLASHCARD_ESSAY_REQUEST_RESERVE);
  const budgetCeiling = Math.floor(config.dailyBudgetMicroUsd * 0.75);
  const available = Boolean(config.apiKey) && config.dailyBudgetMicroUsd > 0;
  const safe = (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      try { return await handler(request, reply); }
      catch (error) {
        if (error instanceof AiStorageError) return reply.code(error.statusCode).send({ error: error.statusCode >= 500
          ? 'AI grading could not be completed. Choose a rating yourself.' : error.message });
        if (error instanceof z.ZodError || error instanceof FlashcardGradeRequestError) return reply.code(400).send({ error: 'Invalid flashcard grading request. Choose a rating yourself.' });
        return reply.code(500).send({ error: 'AI grading could not be completed. Choose a rating yourself.' });
      }
    };
  const rebuild = (body: z.infer<typeof PreviewBody>) => {
    const card = options.catalog.cards.find(item => item.id === body.cardId);
    if (!card || nativeContentVersion(card) !== body.cardFingerprint) throw new AiStorageError(409, 'This card changed. Reload due cards.');
    return buildFlashcardGradeRequest({ front: card.front, back: card.back, response: body.response, model: config.model });
  };

  app.get('/api/flashcard-grade/status', safe(async request => {
    // No key means no database access, including on an unmigrated host.
    const usage = available ? await options.storage(request).usage(dayEt(clock())) : null;
    return { available, ...(!available ? { reason: config.apiKey ? 'AI checking is disabled by the daily budget. Choose a rating yourself.' : unavailable } : {}),
      model: config.model, privacyNotice: FLASHCARD_AI_PRIVACY_NOTICE,
      remainingFlashcardRequestsToday: available && (usage?.spentMicroUsd ?? 0) + (usage?.reservedMicroUsd ?? 0) < budgetCeiling
        ? Math.max(0, requestCeiling - (usage?.requests ?? 0)) : 0 };
  }));
  app.post('/api/flashcard-grade/preview', safe(async request => {
    const preview = rebuild(PreviewBody.parse(request.body));
    return { available, model: config.model, sentData: preview.sentData, previewSha256: preview.previewSha256, privacyNotice: FLASHCARD_AI_PRIVACY_NOTICE };
  }));
  app.post('/api/flashcard-grade', {
    onRequest: async (request, reply) => { try { if (typeof request.raw.socket?.setTimeout === 'function') {
      request.raw.setTimeout?.(60_000); reply.raw.setTimeout?.(60_000);
    } } catch { /* Best effort; serverless platforms enforce their own duration. */ } },
  }, safe(async (request, reply) => {
    if (!request.body || typeof request.body !== 'object' || !('consent' in request.body) || request.body.consent !== true) {
      return reply.code(400).send({ error: 'Explicit consent is required before sending a card to DeepSeek' });
    }
    const body = GradeBody.parse(request.body);
    if (!config.apiKey) return reply.code(501).send({ available: false, error: unavailable });
    if (config.dailyBudgetMicroUsd === 0) return reply.code(429).send({ error: limitReached });
    // Validate all catalog content limits and identities before any ledger work.
    const preview = rebuild(body);
    if (preview.previewSha256 !== body.previewSha256) return reply.code(409).send({ error: 'The preview changed. Review a fresh preview before checking again.' });
    if (exactRecallMatch(body.response, preview.sentData.back)) return { closeness: 'correct', source: 'exact', explanation: 'Matches the target answer.' };
    const storage = options.storage(request), day = dayEt(clock());
    const reservedMicroUsd = estimateCostMicroUsd(preview.messages, config);
    if (!await storage.reserve(day, reservedMicroUsd, budgetCeiling, requestCeiling)) return reply.code(429).send({ error: limitReached });
    let costMicroUsd = reservedMicroUsd, inputTokens = 0, outputTokens = 0, retainReservation = true;
    let result: ReturnType<typeof validateFlashcardGradeOutput> | null = null;
    let responseCode = 502, errorMessage = FLASHCARD_INVALID_OUTPUT;
    try {
      const response = await adapter.complete(preview.messages);
      if (response.usage) {
        retainReservation = false; costMicroUsd = usageCostMicroUsd(response.usage, config);
        inputTokens = response.usage.promptTokens; outputTokens = response.usage.completionTokens;
      }
      result = validateFlashcardGradeOutput(response.content);
    } catch (error) {
      if (error instanceof AiAdapterError) {
        if (!error.responseReceived) { costMicroUsd = 0; retainReservation = false; }
        else if (error.usage) {
          retainReservation = false; costMicroUsd = usageCostMicroUsd(error.usage, config);
          inputTokens = error.usage.promptTokens; outputTokens = error.usage.completionTokens;
        }
        responseCode = error.statusCode;
        errorMessage = error.kind === 'invalid' ? FLASHCARD_INVALID_OUTPUT :
          error.statusCode === 504 ? 'The AI check timed out. Choose a rating yourself.' :
          error.statusCode === 429 ? 'The AI provider is temporarily rate limited. Choose a rating yourself.' :
          'The AI provider is temporarily unavailable. Choose a rating yourself.';
      }
    }
    await storage.settleUsage({ day, reservedMicroUsd, costMicroUsd, inputTokens, outputTokens, retainReservation });
    if (!result) return reply.code(responseCode).send({ error: errorMessage });
    return { ...result, source: 'ai', warning: 'Unofficial AI closeness check. It is not an MTEL score and does not count as evidence.' };
  }));
}
