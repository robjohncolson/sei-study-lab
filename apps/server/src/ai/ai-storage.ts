import type { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import type { Catalog, ProposalSchema } from '../../../../packages/shared/src/index.js';
import type { Attempt, Evidence, Judgment, Json } from '../types.js';

export type AiProposal = z.infer<typeof ProposalSchema>;
export type AiDailyUsage = { requests: number; reservedMicroUsd: number; spentMicroUsd: number; inputTokens: number; outputTokens: number };
export type AiStoredAttempt = { attempt: Attempt; task: Catalog['tasks'][number]; mentorTexts: Catalog['mentorTexts']; rubrics: Catalog['rubrics'] };
export type AiRequestRecord = {
  id: string; attemptId: string; previewSha256: string; model: string;
  status: 'validated' | 'invalid' | 'failed'; proposal: AiProposal | null;
  costMicroUsd: number; createdAt: string;
};
export type AiFinish = { day: string; reservedMicroUsd: number; costMicroUsd: number; inputTokens: number; outputTokens: number; request: AiRequestRecord; retainReservation?: boolean };
export type AiApproval = { judgment: Judgment; evidenceEvents: Evidence[]; duplicate: boolean };
export interface AiStorage {
  loadAttempt(attemptId: string): Promise<AiStoredAttempt | null>;
  usage(day: string): Promise<AiDailyUsage>;
  reserve(day: string, estimateMicroUsd: number, budgetMicroUsd: number, requestCap: number): Promise<boolean>;
  finish(value: AiFinish): Promise<void>;
  approve(requestId: string): Promise<AiApproval>;
}
export class AiStorageError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
export const emptyAiUsage = (): AiDailyUsage => ({ requests: 0, reservedMicroUsd: 0, spentMicroUsd: 0, inputTokens: 0, outputTokens: 0 });

export function assertAiApprovalIdentity(judgment: Judgment, proposal: AiProposal) {
  if (judgment.judgeKind !== 'ai_approved_proposal' || judgment.attemptId !== proposal.attemptId ||
    judgment.result.status !== 'needs_review' || !judgment.result.provisional || judgment.result.sourceChecked ||
    !isDeepStrictEqual(judgment.result.proposal, proposal)) {
    throw new AiStorageError(409, 'AI feedback approval identity conflicts with existing history.');
  }
}

/** A stable request identity makes approval append-only and idempotent. */
export function aiJudgment(requestId: string, proposal: AiProposal, createdAt: string): Judgment {
  return {
    id: requestId, attemptId: proposal.attemptId, judgeKind: 'ai_approved_proposal', judgeVersion: proposal.judgeLabel,
    rubricVersionId: typeof proposal.rubricVersion === 'string' ? proposal.rubricVersion : null,
    result: { status: 'needs_review', provisional: true, sourceChecked: false,
      feedback: proposal.criteriaFeedback.map(item => `${item.criterionId}: ${item.comment}${item.missingEvidence.length ? ' Missing/ambiguous: ' + item.missingEvidence.join('; ') : ''}`).join('\n') || proposal.reason,
      proposal: proposal as unknown as Json },
    quotedEvidence: proposal.criteriaFeedback.flatMap(item => item.answerQuotes),
    uncertaintyReason: proposal.reason || 'AI scoring has not been independently validated',
    supersedesId: null, createdAt,
  };
}
