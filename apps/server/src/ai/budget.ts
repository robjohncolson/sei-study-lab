import type { AiConfig } from './ai-config.js';
import type { AiMessage } from './feedback-request.js';

export type AiUsage = { promptTokens: number; cacheHitTokens: number; cacheMissTokens: number; completionTokens: number };

/** Calendar boundaries follow New York, including both daylight saving transitions. */
export function dayEt(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = (type: string) => parts.find(value => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

// USD per million tokens is numerically micro-USD per token. Round the aggregate
// upward so fractions of one micro-dollar never undercharge the budget ledger.
function microUsd(value: number): number {
  const cost = Math.ceil(value);
  if (!Number.isSafeInteger(cost) || cost < 0) throw new Error('AI cost is out of range');
  return cost;
}

export function estimateCostMicroUsd(messages: AiMessage[], config: AiConfig): number {
  const inputTokens = Math.ceil(JSON.stringify(messages).length / 3);
  return microUsd(inputTokens * config.priceInputMissPerM + config.maxOutputTokens * config.priceOutputPerM);
}

export function usageCostMicroUsd(usage: AiUsage, config: AiConfig): number {
  return microUsd(usage.cacheMissTokens * config.priceInputMissPerM + usage.cacheHitTokens * config.priceInputHitPerM + usage.completionTokens * config.priceOutputPerM);
}

/** Missing cache counters conservatively bill all input at the miss price. */
export function parseAiUsage(value: unknown): AiUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const token = (item: unknown): item is number => typeof item === 'number' && Number.isSafeInteger(item) && item >= 0 && item <= 1_000_000_000;
  if (!token(raw.prompt_tokens) || !token(raw.completion_tokens)) return null;
  const hit = raw.prompt_cache_hit_tokens, miss = raw.prompt_cache_miss_tokens;
  if (hit === undefined && miss === undefined) return { promptTokens: raw.prompt_tokens, cacheHitTokens: 0, cacheMissTokens: raw.prompt_tokens, completionTokens: raw.completion_tokens };
  if (!token(hit) || !token(miss) || hit + miss !== raw.prompt_tokens) return null;
  return { promptTokens: raw.prompt_tokens, cacheHitTokens: hit, cacheMissTokens: miss, completionTokens: raw.completion_tokens };
}
