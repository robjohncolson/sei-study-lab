import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { ProposalSchema, type Catalog } from '../../../../packages/shared/src/index.js';
import type { VerifiedOwnerClaims } from '../hosted-auth.js';
import { withOwnerTransaction } from '../postgres/transaction.js';
import { deriveStudyEvidence } from '../study-logic.js';
import type { Attempt, Judgment } from '../types.js';
import { aiJudgment, assertAiApprovalIdentity, AiStorageError, emptyAiUsage, type AiStorage, type AiFinish } from './ai-storage.js';

export class PostgresAiStorage implements AiStorage {
  constructor(readonly pool: Pool, readonly claims: VerifiedOwnerClaims, readonly catalog: Catalog,
    readonly clock: () => Date = () => new Date()) {}

  async loadAttempt(attemptId: string) {
    return withOwnerTransaction(this.pool, this.claims, async client => {
      const result = await client.query<{ attempt: Attempt; task: Catalog['tasks'][number] }>(`
        SELECT a.entity_json AS attempt,t.entity_json AS task FROM sei.attempts a
        JOIN sei.task_versions t ON t.owner_id=a.owner_id AND t.id=a.task_id AND t.version=a.task_version
        WHERE a.owner_id=$1 AND a.id=$2`, [this.claims.sub, attemptId]);
      const stored = result.rows[0];
      // Hosted mentor/rubric versions are the server's versioned source bundle.
      // The request builder verifies the attempt's exact id/version/hash binding.
      return stored ? { ...stored, mentorTexts: this.catalog.mentorTexts, rubrics: this.catalog.rubrics } : null;
    });
  }

  async usage(day: string) {
    return withOwnerTransaction(this.pool, this.claims, async client => {
      const result = await client.query<{ requests: number; reserved_micro_usd: string; spent_micro_usd: string; input_tokens: string; output_tokens: string }>(
        'SELECT * FROM sei.ai_feedback_usage WHERE owner_id=$1 AND day_et=$2', [this.claims.sub, day]);
      const row = result.rows[0];
      return row ? { requests: Number(row.requests), reservedMicroUsd: Number(row.reserved_micro_usd),
        spentMicroUsd: Number(row.spent_micro_usd), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens) } : emptyAiUsage();
    });
  }

  async reserve(day: string, estimateMicroUsd: number, budgetMicroUsd: number, requestCap: number) {
    // This short owner transaction commits before any outbound HTTP request.
    return withOwnerTransaction(this.pool, this.claims, async client => {
      const now = this.clock().toISOString();
      await client.query(`INSERT INTO sei.ai_feedback_usage(owner_id,day_et,updated_at) VALUES($1,$2,$3)
        ON CONFLICT(owner_id,day_et) DO NOTHING`, [this.claims.sub, day, now]);
      const result = await client.query(`UPDATE sei.ai_feedback_usage SET requests=requests+1,
        reserved_micro_usd=reserved_micro_usd+$3,updated_at=$4 WHERE owner_id=$1 AND day_et=$2
        AND requests<$5 AND spent_micro_usd+reserved_micro_usd+$3<=$6 RETURNING requests`,
      [this.claims.sub, day, estimateMicroUsd, now, requestCap, budgetMicroUsd]);
      return result.rowCount === 1;
    });
  }

  async finish(value: AiFinish) {
    await withOwnerTransaction(this.pool, this.claims, async client => {
      await client.query('SELECT requests FROM sei.ai_feedback_usage WHERE owner_id=$1 AND day_et=$2 FOR UPDATE', [this.claims.sub, value.day]);
      const existing = await client.query('SELECT 1 FROM sei.ai_feedback_requests WHERE owner_id=$1 AND id=$2', [this.claims.sub, value.request.id]);
      if (existing.rowCount) return;
      const changed = await client.query(`UPDATE sei.ai_feedback_usage SET reserved_micro_usd=reserved_micro_usd-$3,
        spent_micro_usd=spent_micro_usd+$4,input_tokens=input_tokens+$5,output_tokens=output_tokens+$6,updated_at=$7
        WHERE owner_id=$1 AND day_et=$2 AND reserved_micro_usd>=$8 RETURNING requests`,
      [this.claims.sub, value.day, value.retainReservation ? 0 : value.reservedMicroUsd, value.retainReservation ? 0 : value.costMicroUsd,
        value.inputTokens, value.outputTokens, this.clock().toISOString(), value.reservedMicroUsd]);
      if (changed.rowCount !== 1) throw new AiStorageError(500, 'AI feedback accounting could not be completed.');
      const row = value.request;
      await client.query(`INSERT INTO sei.ai_feedback_requests(owner_id,id,attempt_id,preview_sha256,model,status,proposal_json,cost_micro_usd,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9)`, [this.claims.sub, row.id, row.attemptId, row.previewSha256, row.model, row.status,
        row.proposal ? JSON.stringify(ProposalSchema.parse(row.proposal)) : null, value.costMicroUsd, row.createdAt]);
    });
  }

  async approve(requestId: string) {
    return withOwnerTransaction(this.pool, this.claims, async client => {
      // Serialize against other approvals and the owner's normal study writes.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [this.claims.sub]);
      const result = await client.query<{ proposal_json: unknown }>(
        "SELECT proposal_json FROM sei.ai_feedback_requests WHERE owner_id=$1 AND id=$2 AND status='validated'", [this.claims.sub, requestId]);
      if (!result.rows[0]) throw new AiStorageError(404, 'Validated AI feedback was not found.');
      const proposal = ProposalSchema.parse(result.rows[0].proposal_json);
      const existing = await client.query<{ entity_json: Judgment }>('SELECT entity_json FROM sei.judgments WHERE owner_id=$1 AND id=$2', [this.claims.sub, requestId]);
      if (existing.rows[0]) { assertAiApprovalIdentity(existing.rows[0].entity_json, proposal); return { judgment: existing.rows[0].entity_json, evidenceEvents: [], duplicate: true }; }
      const attempts = await client.query<{ entity_json: Attempt }>('SELECT entity_json FROM sei.attempts WHERE owner_id=$1 ORDER BY sequence', [this.claims.sub]);
      const allAttempts = attempts.rows.map(row => row.entity_json), attempt = allAttempts.find(row => row.id === proposal.attemptId);
      if (!attempt) throw new AiStorageError(404, 'Validated AI feedback was not found.');
      const tasks = await client.query<{ entity_json: Catalog['tasks'][number] }>(
        'SELECT entity_json FROM sei.task_versions WHERE owner_id=$1 AND id=$2 AND version=$3', [this.claims.sub, attempt.taskId, String(attempt.taskVersion)]);
      const task = tasks.rows[0]?.entity_json;
      if (!task) throw new AiStorageError(404, 'Validated AI feedback was not found.');
      const judgment = aiJudgment(requestId, proposal, this.clock().toISOString());
      await client.query(`INSERT INTO sei.judgments(owner_id,id,attempt_id,supersedes_id,entity_json)
        VALUES($1,$2,$3,NULL,$4::json)`, [this.claims.sub, judgment.id, judgment.attemptId, JSON.stringify(judgment)]);
      const evidenceEvents = deriveStudyEvidence(task, attempt, judgment, allAttempts, task.skillIds.map(() => randomUUID())).filter(event => event.eligible);
      for (const event of evidenceEvents) await client.query(`INSERT INTO sei.evidence_events(owner_id,id,attempt_id,judgment_id,entity_json)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [this.claims.sub, event.id, event.attemptId, event.judgmentId, JSON.stringify(event)]);
      return { judgment, evidenceEvents, duplicate: false };
    });
  }
}
