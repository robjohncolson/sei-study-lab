import { createHash } from 'node:crypto';
import { createEmptyCard, fsrs, generatorParameters, type Card, type ReviewLog } from 'ts-fsrs';
import {
  NativeCardContentSchema, NativeInstantSchema, NativeLibraryCardSchema, NativeLibraryLogSchema,
  NativeRatingSchema, NativeSchedulerConfigSchema,
  type NativeCardContent, type NativeLibraryCard, type NativeLibraryLog, type NativeRating,
  type NativeSchedulerConfig,
} from '../../../packages/shared/src/native-fsrs.js';

/** Stable JSON for content and immutable event identities, without lossy coercion. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  throw new Error('Native scheduler records require finite, plain JSON values');
}

export function hashNative(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function nativeClock(now: Date): string {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('Invalid server review time');
  return NativeInstantSchema.parse(now.toISOString());
}

export function currentNativeConfig(): NativeSchedulerConfig {
  // generatorParameters is the source of the complete FSRS-6 defaults and weights.
  const base = {
    schemaVersion: 1 as const,
    library: 'ts-fsrs' as const,
    libraryVersion: '5.4.2' as const,
    model: 'FSRS-6' as const,
    parameters: generatorParameters({ request_retention: 0.9, enable_fuzz: false }),
  };
  return NativeSchedulerConfigSchema.parse({ ...base, hash: hashNative(base) });
}

export function validateNativeConfig(input: unknown): NativeSchedulerConfig {
  const config = NativeSchedulerConfigSchema.parse(input);
  const { hash, ...base } = config;
  if (hashNative(base) !== hash) throw new Error('Native scheduler configuration hash mismatch');
  const supported = currentNativeConfig();
  if (canonicalJson(config) !== canonicalJson(supported)) throw new Error('Unsupported native scheduler configuration');
  return config;
}

export function nativeContentVersion(content: NativeCardContent): string {
  return hashNative(NativeCardContentSchema.parse(content));
}

export function serializeNativeCard(card: Card): NativeLibraryCard {
  const { due, last_review, ...rest } = card;
  return NativeLibraryCardSchema.parse({ ...rest, due: nativeClock(due), ...(last_review ? { last_review: nativeClock(last_review) } : {}) });
}

export function deserializeNativeCard(input: NativeLibraryCard): Card {
  const card = NativeLibraryCardSchema.parse(input);
  const { due, last_review, ...rest } = card;
  return { ...rest, due: new Date(due), ...(last_review ? { last_review: new Date(last_review) } : {}) };
}

export function serializeNativeLog(log: ReviewLog): NativeLibraryLog {
  return NativeLibraryLogSchema.parse({ ...log, due: nativeClock(log.due), review: nativeClock(log.review) });
}

export function deserializeNativeLog(input: NativeLibraryLog): ReviewLog {
  const log = NativeLibraryLogSchema.parse(input);
  return { ...log, due: new Date(log.due), review: new Date(log.review) };
}

export function initialNativeCard(now: Date): NativeLibraryCard {
  nativeClock(now);
  return serializeNativeCard(createEmptyCard(now));
}

function schedulingInputs(card: NativeLibraryCard, now: Date, config: NativeSchedulerConfig) {
  nativeClock(now);
  const parsed = deserializeNativeCard(card);
  if (parsed.last_review && parsed.last_review.getTime() > now.getTime()) throw new Error('Server time precedes the last review');
  return { card: parsed, scheduler: fsrs(validateNativeConfig(config).parameters) };
}

export function scheduleNative(card: NativeLibraryCard, now: Date, rating: NativeRating, config: NativeSchedulerConfig = currentNativeConfig()): { card: NativeLibraryCard; log: NativeLibraryLog } {
  const inputs = schedulingInputs(card, now, config);
  const result = inputs.scheduler.next(inputs.card, now, NativeRatingSchema.parse(rating));
  return { card: serializeNativeCard(result.card), log: serializeNativeLog(result.log) };
}

export function forgetNative(card: NativeLibraryCard, now: Date, config: NativeSchedulerConfig = currentNativeConfig()): { card: NativeLibraryCard; log: NativeLibraryLog } {
  const inputs = schedulingInputs(card, now, config);
  // The library owns reset behavior, including the returned Manual log.
  const result = inputs.scheduler.forget(inputs.card, now, true);
  return { card: serializeNativeCard(result.card), log: serializeNativeLog(result.log) };
}
