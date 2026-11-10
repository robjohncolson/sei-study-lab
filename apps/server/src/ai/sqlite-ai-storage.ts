import type { Catalog } from '../../../../packages/shared/src/index.js';
import { ProposalSchema } from '../../../../packages/shared/src/index.js';
import { canonical, type SeiStore } from '../store.js';
import type { Attempt, Judgment } from '../types.js';
import { aiJudgment, assertAiApprovalIdentity, AiStorageError, emptyAiUsage, type AiStorage, type AiFinish, type AiUsageSettlement } from './ai-storage.js';

// A local SQLite installation is one owner; sessions do not create budget identities.
const LOCAL_OWNER = '00000000-0000-4000-8000-000000000001';
export class SqliteAiStorage implements AiStorage {
  constructor(readonly store: SeiStore, readonly clock: () => Date = () => new Date()) {}

  async loadAttempt(attemptId: string) {
    const attempt = this.store.existing<Attempt>('attempts', attemptId);
    if (!attempt) return null;
    return { attempt, task: this.store.task(attempt.taskId, attempt.taskVersion),
      mentorTexts: this.store.entities<Catalog['mentorTexts'][number]>('mentor_texts'),
      rubrics: this.store.entities<Catalog['rubrics'][number]>('rubrics') };
  }

  async usage(day: string) {
    const row = this.store.db.prepare('SELECT * FROM ai_feedback_usage WHERE owner_id=? AND day_et=?').get(LOCAL_OWNER, day);
    return row ? { requests: Number(row.requests), reservedMicroUsd: Number(row.reserved_micro_usd),
      spentMicroUsd: Number(row.spent_micro_usd), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) } : emptyAiUsage();
  }

  async reserve(day: string, estimateMicroUsd: number, budgetMicroUsd: number, requestCap: number) {
    return this.store.transaction(() => {
      const now = this.clock().toISOString();
      this.store.db.prepare('INSERT OR IGNORE INTO ai_feedback_usage(owner_id,day_et,updated_at) VALUES(?,?,?)').run(LOCAL_OWNER, day, now);
      const row = this.store.db.prepare(`UPDATE ai_feedback_usage SET requests=requests+1,
        reserved_micro_usd=reserved_micro_usd+?, updated_at=? WHERE owner_id=? AND day_et=?
        AND requests<? AND spent_micro_usd+reserved_micro_usd+?<=? RETURNING requests`)
        .get(estimateMicroUsd, now, LOCAL_OWNER, day, requestCap, estimateMicroUsd, budgetMicroUsd);
      return row !== undefined;
    });
  }

  async finish(value: AiFinish) {
    this.store.transaction(() => {
      // Repeated completion cannot charge twice or consume another request's reservation.
      if (this.store.db.prepare('SELECT 1 FROM ai_feedback_requests WHERE owner_id=? AND id=?').get(LOCAL_OWNER, value.request.id)) return;
      const changed = this.store.db.prepare(`UPDATE ai_feedback_usage SET reserved_micro_usd=reserved_micro_usd-?,
        spent_micro_usd=spent_micro_usd+?,input_tokens=input_tokens+?,output_tokens=output_tokens+?,updated_at=?
        WHERE owner_id=? AND day_et=? AND reserved_micro_usd>=? RETURNING requests`).get(value.retainReservation ? 0 : value.reservedMicroUsd,
        value.retainReservation ? 0 : value.costMicroUsd, value.inputTokens, value.outputTokens, this.clock().toISOString(), LOCAL_OWNER, value.day, value.reservedMicroUsd);
      if (!changed) throw new AiStorageError(500, 'AI feedback accounting could not be completed.');
      const row = value.request;
      this.store.db.prepare(`INSERT INTO ai_feedback_requests(owner_id,id,attempt_id,preview_sha256,model,status,proposal_json,cost_micro_usd,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`).run(LOCAL_OWNER, row.id, row.attemptId, row.previewSha256, row.model,
        row.status, row.proposal ? canonical(ProposalSchema.parse(row.proposal)) : null, value.costMicroUsd, row.createdAt);
    });
  }

  /** Complete a reserved flashcard call without an attempt-bound history row. */
  async settleUsage(value: AiUsageSettlement) {
    try {
      this.store.transaction(() => {
        const changed = this.store.db.prepare(`UPDATE ai_feedback_usage SET reserved_micro_usd=reserved_micro_usd-?,
          spent_micro_usd=spent_micro_usd+?,input_tokens=input_tokens+?,output_tokens=output_tokens+?,updated_at=?
          WHERE owner_id=? AND day_et=? AND reserved_micro_usd>=? RETURNING requests`).get(value.retainReservation ? 0 : value.reservedMicroUsd,
          value.retainReservation ? 0 : value.costMicroUsd, value.inputTokens, value.outputTokens, this.clock().toISOString(), LOCAL_OWNER, value.day, value.reservedMicroUsd);
        if (!changed) throw new AiStorageError(500, 'AI feedback accounting could not be completed.');
      });
    } catch { throw new AiStorageError(500, 'AI feedback accounting could not be completed.'); }
  }

  async approve(requestId: string) {
    return this.store.transaction(() => {
      const row = this.store.db.prepare("SELECT proposal_json FROM ai_feedback_requests WHERE owner_id=? AND id=? AND status='validated'").get(LOCAL_OWNER, requestId);
      if (!row) throw new AiStorageError(404, 'Validated AI feedback was not found.');
      const proposal = ProposalSchema.parse(JSON.parse(String(row.proposal_json)));
      const existing = this.store.existing<Judgment>('judgments', requestId);
      if (existing) { assertAiApprovalIdentity(existing, proposal); return { judgment: existing, evidenceEvents: [], duplicate: true }; }
      const attempt = this.store.existing<Attempt>('attempts', proposal.attemptId);
      if (!attempt) throw new AiStorageError(404, 'Validated AI feedback was not found.');
      const judgment = aiJudgment(requestId, proposal, this.clock().toISOString());
      this.store.saveJudgment(judgment);
      // Diagnostic pending rows are unnecessary for an unofficial AI draft. The
      // existing evidence policy admits no eligible evidence from this judgment.
      const evidenceEvents = this.store.deriveEvidence(attempt, judgment).filter(event => event.eligible);
      for (const event of evidenceEvents) this.store.saveEvidence(event);
      return { judgment, evidenceEvents, duplicate: false };
    });
  }
}
