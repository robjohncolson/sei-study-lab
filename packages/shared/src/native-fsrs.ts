import { z } from 'zod';

// These records describe recall scheduling, never keyed correctness or evidence.
export const NativeInstantSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).refine(value => {
  const instant = new Date(value);
  return Number.isFinite(instant.getTime()) && instant.toISOString() === value;
}, 'Expected a canonical UTC instant');
export const NativeHashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const finite = z.number().finite();
const nonnegative = finite.nonnegative();
const count = nonnegative.int().max(Number.MAX_SAFE_INTEGER);

export const NativeCardContentSchema = z.object({
  id: z.string().min(1).max(200),
  front: z.string().max(100000),
  back: z.string().max(100000),
  source: z.string().max(10000),
  tags: z.array(z.string().min(1).max(200)).max(1000),
}).strict();
export type NativeCardContent = z.infer<typeof NativeCardContentSchema>;

export const NativeLibraryCardSchema = z.object({
  due: NativeInstantSchema,
  stability: nonnegative,
  difficulty: nonnegative.max(10),
  elapsed_days: nonnegative,
  scheduled_days: nonnegative,
  learning_steps: count,
  reps: count,
  lapses: count,
  state: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  last_review: NativeInstantSchema.optional(),
}).strict();
export type NativeLibraryCard = z.infer<typeof NativeLibraryCardSchema>;

export const NativeLibraryLogSchema = z.object({
  rating: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  state: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  due: NativeInstantSchema,
  stability: nonnegative,
  difficulty: nonnegative.max(10),
  elapsed_days: nonnegative,
  last_elapsed_days: nonnegative,
  // ts-fsrs forget() records a signed interval here when reset precedes due.
  // This exception belongs only to Manual logs, never actual card schedules.
  scheduled_days: finite,
  learning_steps: count,
  review: NativeInstantSchema,
}).strict().refine(log => log.rating === 0 || log.scheduled_days >= 0, {
  path: ['scheduled_days'], message: 'Review scheduled days must be nonnegative',
});
export type NativeLibraryLog = z.infer<typeof NativeLibraryLogSchema>;
export const NativeRatingSchema = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type NativeRating = z.infer<typeof NativeRatingSchema>;

const step = z.templateLiteral([z.number().positive(), z.enum(['m', 'h', 'd'])]);
export const NativeParametersSchema = z.object({
  request_retention: finite.gt(0).lt(1),
  maximum_interval: count.positive(),
  w: z.array(finite).length(21),
  enable_fuzz: z.literal(false),
  enable_short_term: z.boolean(),
  learning_steps: z.array(step).max(20),
  relearning_steps: z.array(step).max(20),
}).strict();
export const NativeSchedulerConfigSchema = z.object({
  schemaVersion: z.literal(1),
  library: z.literal('ts-fsrs'),
  libraryVersion: z.literal('5.4.2'),
  model: z.literal('FSRS-6'),
  parameters: NativeParametersSchema,
  hash: NativeHashSchema,
}).strict();
export type NativeSchedulerConfig = z.infer<typeof NativeSchedulerConfigSchema>;

const writeIdentity = {
  clientEventId: z.string().uuid(),
  cardId: z.string().min(1).max(200),
  cardFingerprint: NativeHashSchema,
  expectedVersion: count.positive(),
  clientNow: NativeInstantSchema,
};
export const NativeReviewSchema = z.object({
  ...writeIdentity,
  response: z.string().max(150000),
  assistance: z.array(z.string().min(1).max(300)).max(30),
  hintCount: count.max(1000),
  rating: NativeRatingSchema,
  revealed: z.literal(true),
  revealedAt: NativeInstantSchema,
  startedAt: NativeInstantSchema,
}).strict();
export type NativeReviewInput = z.infer<typeof NativeReviewSchema>;
export type NativeReviewRequest = NativeReviewInput;

export const NativeControlSchema = z.object({
  ...writeIdentity,
  action: z.enum(['keep', 'reset', 'suspend', 'resume']),
}).strict();
export type NativeControlInput = z.infer<typeof NativeControlSchema>;
export type NativeControlRequest = NativeControlInput;

export type NativeQueueItem = {
  card: NativeCardContent;
  cardFingerprint: string;
  acknowledgedFingerprint: string;
  version: number;
  suspended: boolean;
  stale: boolean;
  missing: boolean;
  schedule: NativeLibraryCard;
};
export type NativeQueueResponse = {
  serverNow: string;
  reviewsSynchronized: false;
  config: NativeSchedulerConfig;
  queue: NativeQueueItem[];
  held: NativeQueueItem[];
  nextDue: string | null;
};
export type NativeQueue = NativeQueueResponse;
export type NativeReceipt = {
  clientEventId: string;
  eventId: string;
  cardId: string;
  version: number;
  cardFingerprint: string;
  schedule: NativeLibraryCard;
  suspended: boolean;
  serverNow: string;
};
