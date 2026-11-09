import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { JudgmentSchema } from '../apps/server/src/types.js';

const judgment = () => ({ id: randomUUID(), attemptId: randomUUID(), judgeKind: 'ai_approved_proposal',
  judgeVersion: 'AI draft (DeepSeek deepseek-flash), unofficial', rubricVersionId: 'rubric.mtel56.public@1',
  result: { status: 'needs_review', feedback: 'Synthetic provisional feedback', provisional: true, sourceChecked: false },
  quotedEvidence: [], uncertaintyReason: 'Requires human review', supersedesId: null, createdAt: '2026-11-09T17:00:00.000Z' });

describe('imported AI judgment invariants', () => {
  it('accepts only provisional unchecked feedback awaiting review', () => {
    expect(JudgmentSchema.safeParse(judgment()).success).toBe(true);
    for (const change of [{ status: 'correct' }, { status: 'incorrect' }, { provisional: false }, { sourceChecked: true }]) {
      const original = judgment();
      expect(JudgmentSchema.safeParse({ ...original, result: { ...original.result, ...change } }).success).toBe(false);
    }
  });
});
