import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { Catalog } from '../../../../packages/shared/src/index.js';
import { canonicalJson } from '../native-scheduler.js';
import {
  deriveStudyEvidence, lookupTask, prepareStudyAttempt, scoreStudyAttempt,
  shapeStudyDraft, shapeStudyState, validateStudyDraft,
} from '../study-logic.js';
import type { Attempt, Evidence, Judgment, Json } from '../types.js';

/** Only domain validation errors may be returned to the caller, never SQL details. */
export class PostgresStudyError extends Error {
  constructor(message: string, readonly statusCode = 400) { super(message); }
}

type DraftRow = { taskId: string; taskVersion: string; answer: Json; updatedAt: string };
type EntityTable = 'task_versions' | 'attempts' | 'judgments' | 'evidence_events';

/** One request's claims-bearing withOwnerTransaction owns this client and its commit. */
export class PostgresStudyStore {
  private taskSnapshots?: Catalog['tasks'];

  constructor(
    readonly client: PoolClient,
    readonly ownerId: string,
    readonly catalog: Catalog,
    readonly clock: () => Date = () => new Date(),
  ) {}

  private async entities<T>(table: EntityTable): Promise<T[]> {
    const result = await this.client.query<{ entity_json: T }>(
      `SELECT entity_json FROM sei.${table} WHERE owner_id=$1 ORDER BY sequence`, [this.ownerId]);
    return result.rows.map(row => row.entity_json);
  }

  async seedCatalog(): Promise<Catalog['tasks']> {
    if (this.taskSnapshots) return this.taskSnapshots;
    // Serializes the whole owner operation, including submit's eligibility context.
    // It survives transaction pooling because the lock is transaction-local.
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [this.ownerId]);
    const snapshots = await this.entities<Catalog['tasks'][number]>('task_versions');
    const known = new Map(snapshots.map(task => [JSON.stringify([task.id, String(task.version)]), task]));
    // JSON round-tripping matches SQLite serialization of optional undefined fields.
    const bundled = JSON.parse(JSON.stringify(this.catalog.tasks)) as Catalog['tasks'];
    const missing: Catalog['tasks'] = [];
    for (const task of bundled) {
      const existing = known.get(JSON.stringify([task.id, String(task.version)]));
      if (!existing) missing.push(task);
      else if (canonicalJson(existing) !== canonicalJson(task)) {
        throw new PostgresStudyError(`Immutable catalog conflict: ${task.id}. Increase its version.`, 409);
      }
    }
    if (missing.length) {
      await this.client.query(`
        INSERT INTO sei.task_versions(owner_id,id,version,entity_json)
        SELECT $1, task->>'id', task->>'version', task
        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS bundled(task, ordinal)
        ORDER BY ordinal
        ON CONFLICT (owner_id,id,version) DO NOTHING`, [this.ownerId, JSON.stringify(missing)]);
      this.taskSnapshots = await this.entities<Catalog['tasks'][number]>('task_versions');
      for (const task of missing) {
        const inserted = this.taskSnapshots.find(item => item.id === task.id && String(item.version) === String(task.version));
        if (!inserted || canonicalJson(inserted) !== canonicalJson(task)) {
          throw new PostgresStudyError(`Immutable catalog conflict: ${task.id}. Increase its version.`, 409);
        }
      }
    } else this.taskSnapshots = snapshots;
    return this.taskSnapshots;
  }

  async submit(raw: unknown, sessionId: string) {
    const taskVersions = await this.seedCatalog();
    const attempts = await this.entities<Attempt>('attempts');
    const attempt = prepareStudyAttempt(raw, sessionId,
      { catalog: this.catalog, taskVersions, attempts }, this.clock().toISOString(), randomUUID());
    const task = lookupTask(this.catalog, taskVersions, attempt.taskId, attempt.taskVersion);
    const judgment = scoreStudyAttempt(task, attempt, this.catalog.sources, randomUUID());
    const evidenceEvents = deriveStudyEvidence(task, attempt, judgment, attempts, task.skillIds.map(() => randomUUID()));
    await this.client.query(`INSERT INTO sei.attempts(owner_id,id,task_id,task_version,parent_attempt_id,entity_json)
      VALUES($1,$2,$3,$4,$5,$6::json)`,
    [this.ownerId, attempt.id, attempt.taskId, String(attempt.taskVersion), attempt.parentAttemptId, JSON.stringify(attempt)]);
    await this.client.query(`INSERT INTO sei.judgments(owner_id,id,attempt_id,supersedes_id,entity_json)
      VALUES($1,$2,$3,$4,$5::json)`,
    [this.ownerId, judgment.id, judgment.attemptId, judgment.supersedesId, JSON.stringify(judgment)]);
    for (const event of evidenceEvents) {
      await this.client.query(`INSERT INTO sei.evidence_events(owner_id,id,attempt_id,judgment_id,entity_json)
        VALUES($1,$2,$3,$4,$5::jsonb)`, [this.ownerId, event.id, event.attemptId, event.judgmentId, JSON.stringify(event)]);
    }
    return { attempt, judgment, evidenceEvents };
  }

  private async drafts(taskId?: string): Promise<DraftRow[]> {
    const result = await this.client.query<{
      task_id: string; task_version: string; answer_json: Json; updated_at: Date;
    }>(`SELECT task_id,task_version,answer_json,updated_at FROM sei.drafts WHERE owner_id=$1
      ${taskId === undefined ? 'ORDER BY sequence' : 'AND task_id=$2 ORDER BY updated_at DESC, sequence'}`,
    taskId === undefined ? [this.ownerId] : [this.ownerId, taskId]);
    return result.rows.map(row => ({ taskId: row.task_id, taskVersion: row.task_version,
      answer: row.answer_json, updatedAt: row.updated_at.toISOString() }));
  }

  async state() {
    const taskVersions = await this.seedCatalog();
    return shapeStudyState({ taskVersions, attempts: await this.entities<Attempt>('attempts'),
      judgments: await this.entities<Judgment>('judgments'), evidenceEvents: await this.entities<Evidence>('evidence_events'),
      drafts: await this.drafts() });
  }

  async draft(taskId: string) {
    const taskVersions = await this.seedCatalog();
    const task = lookupTask(this.catalog, taskVersions, taskId);
    return shapeStudyDraft(task, (await this.drafts(taskId)).map(({ taskId: _taskId, ...row }) => row));
  }

  async saveDraft(taskId: string, taskVersion: string | number, answer: Json) {
    await this.seedCatalog();
    const task = validateStudyDraft(this.catalog, taskId, taskVersion, answer);
    const updatedAt = this.clock().toISOString();
    await this.client.query(`INSERT INTO sei.drafts(owner_id,task_id,task_version,answer_json,updated_at)
      VALUES($1,$2,$3,$4::json,$5) ON CONFLICT (owner_id,task_id,task_version)
      DO UPDATE SET answer_json=excluded.answer_json,updated_at=excluded.updated_at`,
    [this.ownerId, taskId, String(task.version), JSON.stringify(answer), updatedAt]);
    return { saved: true, taskVersion: String(task.version), updatedAt };
  }
}
