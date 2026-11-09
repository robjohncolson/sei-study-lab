import { describe, expect, it } from 'vitest';
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
import {
  NativeLibraryCardSchema, NativeLibraryLogSchema, NativeRatingSchema, NativeReviewSchema,
  type NativeRating,
} from '../packages/shared/src/native-fsrs.js';
import {
  canonicalJson, currentNativeConfig, deserializeNativeCard, deserializeNativeLog, forgetNative,
  hashNative, initialNativeCard, nativeClock, nativeContentVersion, scheduleNative,
  serializeNativeCard, serializeNativeLog, validateNativeConfig,
} from '../apps/server/src/native-scheduler.js';

const t0 = new Date('2026-11-09T00:00:00.000Z');
// Independent values supplied from the coordinator's actual ts-fsrs@5.4.2 run.
// Never regenerate these fixture values by calling the implementation under test.
const references: { rating: NativeRating; due: string; stability: number; difficulty: number; state: 1 | 2; learning_steps: number; scheduled_days: number }[] = [
  { rating: 1, due: '2026-11-09T00:01:00.000Z', stability: 0.212, difficulty: 6.4133, state: 1, learning_steps: 0, scheduled_days: 0 },
  { rating: 2, due: '2026-11-09T00:06:00.000Z', stability: 1.2931, difficulty: 5.11217071, state: 1, learning_steps: 0, scheduled_days: 0 },
  { rating: 3, due: '2026-11-09T00:10:00.000Z', stability: 2.3065, difficulty: 2.11810397, state: 1, learning_steps: 1, scheduled_days: 0 },
  { rating: 4, due: '2026-11-17T00:00:00.000Z', stability: 8.2956, difficulty: 1, state: 2, learning_steps: 0, scheduled_days: 8 },
];

describe('pinned FSRS-6 scheduler', () => {
  it('persists the complete pinned library defaults and canonical hash', () => {
    const config = currentNativeConfig();
    expect(config).toEqual({
      schemaVersion: 1, library: 'ts-fsrs', libraryVersion: '5.4.2', model: 'FSRS-6',
      parameters: {
        request_retention: 0.9, maximum_interval: 36500, enable_fuzz: false, enable_short_term: true,
        learning_steps: ['1m', '10m'], relearning_steps: ['10m'],
        w: [0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001, 1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014, 1.8729, 0.5425, 0.0912, 0.0658, 0.1542],
      },
      hash: '2be6f90cea266a64acd9db252d5023c38a10c27060ef759857d130147151440b',
    });
    expect(validateNativeConfig(JSON.parse(JSON.stringify(config)))).toEqual(config);
    expect(() => validateNativeConfig({ ...config, libraryVersion: '6.0.0' })).toThrow();
    expect(() => validateNativeConfig({ ...config, hash: '0'.repeat(64) })).toThrow('hash mismatch');
    const { hash: _hash, ...changed } = config;
    changed.parameters = { ...changed.parameters, request_retention: 0.8 };
    expect(() => validateNativeConfig({ ...changed, hash: hashNative(changed) })).toThrow('Unsupported');
  });

  it('records a fixed initial due anchor', () => {
    expect(initialNativeCard(t0)).toEqual({
      due: '2026-11-09T00:00:00.000Z', stability: 0, difficulty: 0,
      elapsed_days: 0, scheduled_days: 0, learning_steps: 0, reps: 0, lapses: 0, state: 0,
    });
  });

  for (const { rating, ...expected } of references) {
    it(`matches the independent fresh-card reference for rating ${rating}`, () => {
      const initial = initialNativeCard(t0);
      const result = scheduleNative(initial, t0, rating);
      expect(result.card).toEqual({ ...expected, elapsed_days: 0, reps: 1, lapses: 0, last_review: t0.toISOString() });
      expect(result.log.rating).toBe(rating);
      expect(result.log.review).toBe(t0.toISOString());
      expect(initial).toEqual(initialNativeCard(t0));
      expect(serializeNativeCard(deserializeNativeCard(result.card))).toEqual(result.card);
      expect(serializeNativeLog(deserializeNativeLog(result.log))).toEqual(result.log);
    });

    it(`uses the actual server instant for overdue rating ${rating}`, () => {
      const initialReview = scheduleNative(initialNativeCard(t0), t0, 4);
      const now = new Date('2026-11-20T00:00:00.000Z');
      const result = scheduleNative(initialReview.card, now, rating);
      expect(result.log.review).toBe(now.toISOString());
      expect(result.log.elapsed_days).toBe(11);
      expect(result.card.last_review).toBe(now.toISOString());
      expect(Date.parse(result.card.due)).toBeGreaterThan(now.getTime());
      expect(result).toEqual(scheduleNative(initialReview.card, now, rating));
      expect(serializeNativeCard(deserializeNativeCard(result.card))).toEqual(result.card);
      expect(serializeNativeLog(deserializeNativeLog(result.log))).toEqual(result.log);
    });
  }

  it('delegates reset to the library and records its Manual log', () => {
    const reviewed = scheduleNative(initialNativeCard(t0), t0, 4);
    const now = new Date('2026-11-10T00:00:00.000Z');
    const reset = forgetNative(reviewed.card, now);
    expect(reset.card).toMatchObject({ state: 0, reps: 0, lapses: 0, due: now.toISOString() });
    expect(reset.log).toMatchObject({ rating: 0, review: now.toISOString() });
    expect(serializeNativeLog(deserializeNativeLog(reset.log))).toEqual(reset.log);
  });

  it.each(['2026-11-10T00:00:00.000Z', '2026-11-20T00:00:00.000Z'])('preserves the exact library reset card and log at %s', (instant) => {
    const library = fsrs({ enable_fuzz: false });
    const reviewed = library.next(createEmptyCard(t0), t0, Rating.Easy);
    const now = new Date(instant);
    const expected = library.forget(reviewed.card, now, true);
    const reset = forgetNative(serializeNativeCard(reviewed.card), now);
    // JSON's Date serialization supplies an independent full wire comparison.
    expect(reset).toEqual(JSON.parse(JSON.stringify(expected)));
    expect(reset.log.rating).toBe(Rating.Manual);
    if (instant === '2026-11-10T00:00:00.000Z') expect(reset.log.scheduled_days).toBe(-7);
    else expect(reset.log.scheduled_days).toBeGreaterThanOrEqual(0);
    expect(reset.card.scheduled_days).toBeGreaterThanOrEqual(0);
    expect(deserializeNativeCard(reset.card)).toEqual(expected.card);
    expect(deserializeNativeLog(reset.log)).toEqual(expected.log);
    expect(serializeNativeCard(deserializeNativeCard(reset.card))).toEqual(reset.card);
    expect(serializeNativeLog(deserializeNativeLog(reset.log))).toEqual(reset.log);
  });

  it('rejects negative scheduled days for review logs and cards while keeping Manual logs finite', () => {
    for (const { rating } of references) {
      const result = scheduleNative(initialNativeCard(t0), t0, rating);
      const invalidLog = { ...result.log, scheduled_days: -1 };
      const invalidCard = { ...result.card, scheduled_days: -1 };
      expect(NativeLibraryLogSchema.safeParse(invalidLog).success).toBe(false);
      expect(() => deserializeNativeLog(invalidLog)).toThrow();
      expect(() => serializeNativeLog({ ...deserializeNativeLog(result.log), scheduled_days: -1 })).toThrow();
      expect(NativeLibraryCardSchema.safeParse(invalidCard).success).toBe(false);
      expect(() => deserializeNativeCard(invalidCard)).toThrow();
      expect(() => serializeNativeCard({ ...deserializeNativeCard(result.card), scheduled_days: -1 })).toThrow();
    }
    const reset = forgetNative(scheduleNative(initialNativeCard(t0), t0, 4).card, new Date('2026-11-10T00:00:00.000Z'));
    for (const scheduled_days of [Number.NaN, Infinity, -Infinity]) {
      expect(NativeLibraryLogSchema.safeParse({ ...reset.log, scheduled_days }).success).toBe(false);
    }
    for (const field of ['stability', 'difficulty', 'elapsed_days', 'last_elapsed_days', 'learning_steps']) {
      expect(NativeLibraryLogSchema.safeParse({ ...reset.log, [field]: -1 }).success).toBe(false);
    }
    expect(NativeLibraryCardSchema.safeParse({ ...reset.card, scheduled_days: -7 }).success).toBe(false);
  });

  it('rejects invalid times, nonfinite cards, invalid ratings and backwards review time', () => {
    expect(() => initialNativeCard(new Date(Number.NaN))).toThrow();
    expect(() => nativeClock(new Date('invalid'))).toThrow();
    for (const value of [0, 5, Number.NaN, Infinity, '3']) expect(NativeRatingSchema.safeParse(value).success).toBe(false);
    const initial = initialNativeCard(t0);
    expect(NativeLibraryCardSchema.safeParse({ ...initial, stability: Infinity }).success).toBe(false);
    expect(NativeLibraryCardSchema.safeParse({ ...initial, reps: -1 }).success).toBe(false);
    expect(() => scheduleNative({ ...initial, stability: Number.NaN }, t0, 3)).toThrow();
    const reviewed = scheduleNative(initial, t0, 3);
    expect(() => scheduleNative(reviewed.card, new Date(t0.getTime() - 1), 3)).toThrow('precedes');
  });

  it('retains UTC instants across offset and DST boundaries', () => {
    expect(nativeClock(new Date('2026-11-01T01:30:00-04:00'))).toBe('2026-11-01T05:30:00.000Z');
    expect(nativeClock(new Date('2026-11-01T01:30:00-05:00'))).toBe('2026-11-01T06:30:00.000Z');
    expect(nativeClock(new Date('2026-03-08T03:30:00-04:00'))).toBe('2026-03-08T07:30:00.000Z');
  });
});

describe('immutable native identities and recall input', () => {
  const card = { id: 'synthetic', front: 'Front', back: 'Back', source: 'synthetic', tags: ['derived'] };
  it('hashes the whole exact content payload, preserving Unicode, spacing and tag order', () => {
    expect(nativeContentVersion(card)).toBe(nativeContentVersion({ tags: card.tags, source: card.source, back: card.back, front: card.front, id: card.id }));
    for (const field of ['front', 'back', 'source'] as const) expect(nativeContentVersion({ ...card, [field]: `${card[field]}  é` })).not.toBe(nativeContentVersion(card));
    expect(nativeContentVersion({ ...card, tags: ['b', 'a'] })).not.toBe(nativeContentVersion({ ...card, tags: ['a', 'b'] }));
    expect(() => canonicalJson({ invalid: undefined })).toThrow();
    expect(() => hashNative({ invalid: Infinity })).toThrow();
  });

  it('requires reveal, valid provenance, strict identities and preserves the original response', () => {
    const input = {
      clientEventId: 'f13bc610-508f-4e2b-b515-3eaf6093430e', cardId: card.id, cardFingerprint: nativeContentVersion(card),
      expectedVersion: 1, response: '  e\u0301 🌍\n\t漢字  ', assistance: ['copied from source'], hintCount: 1,
      rating: 3, revealed: true, startedAt: t0.toISOString(), revealedAt: t0.toISOString(), clientNow: t0.toISOString(),
    };
    expect(NativeReviewSchema.parse(input).response).toBe(input.response);
    expect(NativeReviewSchema.safeParse({ ...input, rating: 0 }).success).toBe(false);
    expect(NativeReviewSchema.safeParse({ ...input, revealed: false }).success).toBe(false);
    expect(NativeReviewSchema.safeParse({ ...input, dueAt: '2030-01-01T00:00:00.000Z' }).success).toBe(false);
    expect(NativeReviewSchema.safeParse({ ...input, clientNow: '2026-11-09' }).success).toBe(false);
    expect(NativeReviewSchema.safeParse({ ...input, expectedVersion: 0 }).success).toBe(false);
  });
});
