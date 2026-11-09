import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import { z } from 'zod';
import type { Catalog } from '../../../../packages/shared/src/index.js';
import {
  NativeCardContentSchema, NativeControlSchema, NativeHashSchema, NativeInstantSchema,
  NativeLibraryCardSchema, NativeLibraryLogSchema, NativeReviewSchema, NativeSchedulerConfigSchema,
  type NativeCardContent, type NativeControlInput, type NativeQueue, type NativeQueueItem,
  type NativeReceipt, type NativeReviewInput, type NativeSchedulerConfig,
} from '../../../../packages/shared/src/native-fsrs.js';
import { NativeStoreError, type NativeEvent, type NativeProjection } from '../native-store.js';
import type { NativeStoragePort } from '../native-storage.js';
import {
  canonicalJson, currentNativeConfig, forgetNative, hashNative, initialNativeCard,
  nativeClock, nativeContentVersion, scheduleNative, validateNativeConfig,
} from '../native-scheduler.js';

const ProjectionSchema = z.object({
  cardId: z.string().min(1).max(200), version: z.number().int().positive(),
  cardFingerprint: NativeHashSchema, cardSnapshot: NativeCardContentSchema,
  suspended: z.boolean(), schedule: NativeLibraryCardSchema, serverUpdatedAt: NativeInstantSchema,
}).strict();
const EventSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), kind: z.enum(['init', 'review', 'control']),
  cardId: z.string().min(1).max(200), version: z.number().int().positive(),
  cardFingerprint: NativeHashSchema, cardSnapshot: NativeCardContentSchema,
  config: NativeSchedulerConfigSchema, configHash: NativeHashSchema, serverNow: NativeInstantSchema,
  request: z.union([NativeReviewSchema, NativeControlSchema]).nullable(), requestHash: NativeHashSchema.nullable(),
  before: ProjectionSchema.nullable(), after: ProjectionSchema, log: NativeLibraryLogSchema.nullable(),
}).strict();
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const ordinal = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const clockAllowanceMs = 5 * 60 * 1000;

/**
 * One instance belongs to one checked-out client inside a claims-bearing transaction.
 * The caller owns BEGIN/COMMIT/ROLLBACK. Construction performs no queries or writes.
 */
export class PostgresNativeStore implements NativeStoragePort {
  constructor(
    readonly client: PoolClient,
    readonly ownerId: string,
    readonly catalog: Pick<Catalog, 'cards'>,
    readonly clock: () => Date = () => new Date(),
  ) {}

  private now() { return nativeClock(this.clock()); }

  private async lockOwner() {
    // Serializes owner-wide client IDs and initialization (including missing rows).
    // Transaction-local; never relies on a session surviving Supavisor checkout.
    await this.client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [this.ownerId]);
  }

  private async saveConfig(raw: NativeSchedulerConfig) {
    const config = validateNativeConfig(raw);
    const { rows } = await this.client.query('SELECT entity_json FROM sei.native_scheduler_configs WHERE owner_id=$1 AND hash=$2', [this.ownerId, config.hash]);
    if (rows[0]) {
      if (!same(rows[0].entity_json, config)) throw new Error('Native configuration hash conflict');
    } else {
      await this.client.query('INSERT INTO sei.native_scheduler_configs(owner_id,hash,entity_json) VALUES($1,$2,$3::jsonb)', [this.ownerId, config.hash, canonicalJson(config)]);
    }
    return config;
  }

  private async saveContent(card: NativeCardContent) {
    const fingerprint = nativeContentVersion(card);
    const { rows } = await this.client.query('SELECT snapshot_json FROM sei.native_card_versions WHERE owner_id=$1 AND card_id=$2 AND fingerprint=$3', [this.ownerId, card.id, fingerprint]);
    if (rows[0]) {
      if (!same(rows[0].snapshot_json, card)) throw new Error('Native content fingerprint conflict');
    } else {
      await this.client.query('INSERT INTO sei.native_card_versions(owner_id,card_id,fingerprint,snapshot_json) VALUES($1,$2,$3,$4::jsonb)', [this.ownerId, card.id, fingerprint, canonicalJson(card)]);
    }
    return fingerprint;
  }

  private decodeProjection(row: QueryResultRow): NativeProjection {
    const projection = ProjectionSchema.parse(row.entity_json);
    if (projection.cardId !== row.card_id || projection.version !== row.version) throw new Error('Native projection identity mismatch');
    return projection;
  }

  private async projection(cardId: string, lock = false): Promise<NativeProjection | undefined> {
    const sql = lock
      ? 'SELECT * FROM sei.native_flashcard_projections WHERE owner_id=$1 AND card_id=$2 FOR UPDATE'
      : 'SELECT * FROM sei.native_flashcard_projections WHERE owner_id=$1 AND card_id=$2';
    const { rows } = await this.client.query(sql, [this.ownerId, cardId]);
    return rows[0] ? this.decodeProjection(rows[0]) : undefined;
  }

  private async saveProjection(projection: NativeProjection) {
    await this.client.query('INSERT INTO sei.native_flashcard_projections(owner_id,card_id,version,entity_json) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(owner_id,card_id) DO UPDATE SET version=excluded.version,entity_json=excluded.entity_json',
      [this.ownerId, projection.cardId, projection.version, canonicalJson(projection)]);
  }

  private async append(event: NativeEvent) {
    EventSchema.parse(event);
    await this.saveConfig(event.config);
    await this.saveContent(event.cardSnapshot);
    await this.client.query('INSERT INTO sei.native_flashcard_events(owner_id,id,event_version,client_event_id,request_hash,card_id,projection_version,kind,config_hash,fingerprint,server_now,event_hash,entity_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)',
      [this.ownerId, event.id, event.schemaVersion, event.request?.clientEventId ?? null, event.requestHash,
        event.cardId, event.version, event.kind, event.configHash, event.cardFingerprint,
        event.serverNow, hashNative(event), canonicalJson(event)]);
    await this.saveProjection(event.after);
  }

  private decodeEvent(row: QueryResultRow): NativeEvent {
    const event = EventSchema.parse(row.entity_json);
    const serverNow = nativeClock(row.server_now instanceof Date ? row.server_now : new Date(String(row.server_now)));
    if (hashNative(event) !== row.event_hash || event.id !== row.id || event.cardId !== row.card_id ||
      event.version !== row.projection_version || event.kind !== row.kind || event.configHash !== row.config_hash ||
      event.cardFingerprint !== row.fingerprint || event.serverNow !== serverNow ||
      event.schemaVersion !== row.event_version || event.requestHash !== row.request_hash ||
      (event.request?.clientEventId.toLowerCase() ?? null) !== row.client_event_id) throw new Error('Native event identity/hash mismatch');
    return event;
  }

  async history(cardId?: string): Promise<NativeEvent[]> {
    const result = cardId === undefined
      ? await this.client.query('SELECT * FROM sei.native_flashcard_events WHERE owner_id=$1 ORDER BY sequence', [this.ownerId])
      : await this.client.query('SELECT * FROM sei.native_flashcard_events WHERE owner_id=$1 AND card_id=$2 ORDER BY projection_version', [this.ownerId, cardId]);
    return result.rows.map(row => this.decodeEvent(row));
  }

  private receipt(event: NativeEvent): NativeReceipt {
    if (!event.request) throw new Error('Initialization has no client receipt');
    return { clientEventId: event.request.clientEventId, eventId: event.id, cardId: event.cardId,
      version: event.version, cardFingerprint: event.cardFingerprint, schedule: event.after.schedule,
      suspended: event.after.suspended, serverNow: event.serverNow };
  }

  private async duplicate(request: NativeReviewInput | NativeControlInput, kind: 'review' | 'control') {
    const { rows } = await this.client.query('SELECT * FROM sei.native_flashcard_events WHERE owner_id=$1 AND client_event_id=$2', [this.ownerId, request.clientEventId]);
    if (!rows[0]) return undefined;
    const event = this.decodeEvent(rows[0]);
    if (event.kind !== kind || event.requestHash !== hashNative(request) || !same(event.request, request))
      throw new NativeStoreError('This client event ID already belongs to a different payload. Preserve the pending response.');
    return this.receipt(event);
  }

  private activeCard(cardId: string) {
    const cards = this.catalog.cards.filter(card => card.id === cardId);
    if (cards.length !== 1) throw new NativeStoreError('Card is missing, retired, or has an ambiguous identity. Its history is preserved.');
    return NativeCardContentSchema.parse(cards[0]);
  }

  private async validateBase(request: NativeReviewInput | NativeControlInput, now: string) {
    const card = this.activeCard(request.cardId), fingerprint = nativeContentVersion(card);
    const before = await this.projection(request.cardId, true);
    if (!before || before.version !== request.expectedVersion) throw new NativeStoreError('Card state changed. Preserve the pending response and recover it explicitly.');
    if (fingerprint !== request.cardFingerprint) throw new NativeStoreError('Card content changed. Preserve the old response and review the current card deliberately.');
    this.validateClock(request, before, now);
    return { card, fingerprint, before };
  }

  private validateClock(request: NativeReviewInput | NativeControlInput, before: NativeProjection, now: string) {
    if (Date.parse(now) < Date.parse(before.serverUpdatedAt)) throw new NativeStoreError('Server clock moved backwards; review was not recorded.', 400);
    if (Date.parse(request.clientNow) < Date.parse(before.serverUpdatedAt) - clockAllowanceMs ||
      Date.parse(request.clientNow) > Date.parse(now) + clockAllowanceMs)
      throw new NativeStoreError('Client clock is outside the acknowledged server time window. The pending response is preserved.', 400);
  }

  private nextProjection(before: NativeProjection, card: NativeCardContent, now: string): NativeProjection {
    return { ...before, cardId: card.id, version: before.version + 1, cardFingerprint: nativeContentVersion(card), cardSnapshot: card, serverUpdatedAt: now };
  }

  private reviewTransition(before: NativeProjection, card: NativeCardContent, request: NativeReviewInput, now: string, config: NativeSchedulerConfig) {
    if (before.suspended) throw new NativeStoreError('Suspended cards must be resumed before review.');
    if (before.cardFingerprint !== request.cardFingerprint) throw new NativeStoreError('Acknowledge the changed content with Keep, Reset, or Suspend before reviewing.');
    const started = Date.parse(request.startedAt), revealed = Date.parse(request.revealedAt), submitted = Date.parse(request.clientNow);
    if (started > revealed || revealed > submitted || started < Date.parse(before.serverUpdatedAt) - clockAllowanceMs)
      throw new NativeStoreError('Invalid review/reveal chronology; review was not recorded.', 400);
    if (Date.parse(before.schedule.due) > Date.parse(now)) throw new NativeStoreError('Card is not due. Preserve this pending review for explicit recovery.');
    const result = scheduleNative(before.schedule, new Date(now), request.rating, config);
    return { after: { ...this.nextProjection(before, card, now), schedule: result.card }, log: result.log };
  }

  private controlTransition(before: NativeProjection, card: NativeCardContent, request: NativeControlInput, now: string, config: NativeSchedulerConfig) {
    const after = this.nextProjection(before, card, now);
    if (request.action === 'reset') {
      const result = forgetNative(before.schedule, new Date(now), config);
      return { after: { ...after, schedule: result.card }, log: result.log };
    }
    if (request.action === 'suspend') after.suspended = true;
    if (request.action === 'resume') {
      if (!before.suspended) throw new NativeStoreError('Card is already active.');
      if (before.cardFingerprint !== request.cardFingerprint) throw new NativeStoreError('Acknowledge changed content with Keep, Reset, or Suspend before resuming.');
      after.suspended = false;
    }
    return { after, log: null };
  }

  async review(raw: unknown): Promise<NativeReceipt> {
    const request = NativeReviewSchema.parse(raw);
    await this.lockOwner();
    const duplicate = await this.duplicate(request, 'review');
    if (duplicate) return duplicate;
    const now = this.now(), { card, fingerprint, before } = await this.validateBase(request, now), config = currentNativeConfig();
    const transition = this.reviewTransition(before, card, request, now, config);
    const event: NativeEvent = { schemaVersion: 1, id: randomUUID(), kind: 'review', cardId: card.id,
      version: transition.after.version, cardFingerprint: fingerprint, cardSnapshot: card, config,
      configHash: config.hash, serverNow: now, request, requestHash: hashNative(request), before, ...transition };
    await this.append(event);
    return this.receipt(event);
  }

  async control(raw: unknown): Promise<NativeReceipt> {
    const request = NativeControlSchema.parse(raw);
    await this.lockOwner();
    const duplicate = await this.duplicate(request, 'control');
    if (duplicate) return duplicate;
    const now = this.now(), { card, fingerprint, before } = await this.validateBase(request, now), config = currentNativeConfig();
    const transition = this.controlTransition(before, card, request, now, config);
    const event: NativeEvent = { schemaVersion: 1, id: randomUUID(), kind: 'control', cardId: card.id,
      version: transition.after.version, cardFingerprint: fingerprint, cardSnapshot: card, config,
      configHash: config.hash, serverNow: now, request, requestHash: hashNative(request), before, ...transition };
    await this.append(event);
    return this.receipt(event);
  }

  async initialize(): Promise<{ initialized: number }> {
    await this.lockOwner();
    const now = this.now(), config = currentNativeConfig();
    let initialized = 0;
    const seen = new Set<string>();
    for (const raw of this.catalog.cards) {
      const card = NativeCardContentSchema.parse(raw);
      if (seen.has(card.id)) throw new Error('Duplicate native card ID');
      seen.add(card.id);
      if (await this.projection(card.id, true)) continue;
      const existing = await this.client.query('SELECT 1 FROM sei.native_flashcard_events WHERE owner_id=$1 AND card_id=$2 LIMIT 1', [this.ownerId, card.id]);
      if (existing.rows.length) throw new Error('Native projection missing; rebuild before continuing');
      const fingerprint = nativeContentVersion(card);
      const after: NativeProjection = { cardId: card.id, version: 1, cardFingerprint: fingerprint,
        cardSnapshot: card, suspended: false, schedule: initialNativeCard(new Date(now)), serverUpdatedAt: now };
      await this.append({ schemaVersion: 1, id: randomUUID(), kind: 'init', cardId: card.id, version: 1,
        cardFingerprint: fingerprint, cardSnapshot: card, config, configHash: config.hash, serverNow: now,
        request: null, requestHash: null, before: null, after, log: null });
      initialized++;
    }
    return { initialized };
  }

  /** SELECT only. Enrollment and projection rebuild are explicit commands. */
  async queue(limit = 50): Promise<NativeQueue> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new NativeStoreError('Queue limit must be 1–100.', 400);
    const now = this.now(), config = currentNativeConfig();
    const cards = new Map<string, NativeCardContent>();
    for (const raw of this.catalog.cards) {
      const card = NativeCardContentSchema.parse(raw);
      if (cards.has(card.id)) throw new Error('Duplicate native card ID');
      cards.set(card.id, card);
    }
    // One statement observes both projections and missing-history checks at one MVCC snapshot.
    const { rows } = await this.client.query(`SELECT p.*, false AS missing_projection
      FROM sei.native_flashcard_projections p WHERE p.owner_id=$1
      UNION ALL
      SELECT e.owner_id, e.card_id, NULL::integer AS version, NULL::jsonb AS entity_json, true AS missing_projection
      FROM sei.native_flashcard_events e WHERE e.owner_id=$1 AND e.projection_version=1
        AND NOT EXISTS (SELECT 1 FROM sei.native_flashcard_projections p WHERE p.owner_id=e.owner_id AND p.card_id=e.card_id)
      ORDER BY card_id`, [this.ownerId]);
    const items: NativeQueueItem[] = [];
    for (const row of rows) {
      if (row.missing_projection) {
        if (cards.has(String(row.card_id))) throw new Error('Native projection missing; rebuild before continuing');
        continue;
      }
      const projection = this.decodeProjection(row), current = cards.get(projection.cardId);
      const card = current ? NativeCardContentSchema.parse(current) : projection.cardSnapshot;
      const fingerprint = nativeContentVersion(card);
      items.push({ card, cardFingerprint: fingerprint, acknowledgedFingerprint: projection.cardFingerprint,
        version: projection.version, suspended: projection.suspended, stale: fingerprint !== projection.cardFingerprint,
        missing: !current, schedule: projection.schedule });
    }
    const available = items.filter(item => !item.stale && !item.suspended && !item.missing);
    const due = available.filter(item => Date.parse(item.schedule.due) <= Date.parse(now));
    const learningFirst = (item: NativeQueueItem) => item.schedule.state === 1 || item.schedule.state === 3 ? 0 : 1;
    due.sort((a, b) => learningFirst(a) - learningFirst(b) || ordinal(a.schedule.due, b.schedule.due) || ordinal(a.card.id, b.card.id));
    const future = available.filter(item => Date.parse(item.schedule.due) > Date.parse(now)).map(item => item.schedule.due).sort();
    return { serverNow: now, config, reviewsSynchronized: false, queue: due.slice(0, limit),
      held: items.filter(item => item.stale || item.suspended || item.missing), nextDue: future[0] ?? null };
  }

  /** Replay exact ts-fsrs card/log JSON; no current catalog or clock participates. */
  async rebuild(): Promise<NativeProjection[]> {
    await this.lockOwner();
    const configs = new Map<string, NativeSchedulerConfig>();
    const configRows = await this.client.query('SELECT * FROM sei.native_scheduler_configs WHERE owner_id=$1', [this.ownerId]);
    for (const row of configRows.rows) {
      const config = validateNativeConfig(row.entity_json);
      if (row.hash !== config.hash) throw new Error('Native scheduler configuration identity mismatch');
      configs.set(config.hash, config);
    }
    const contents = new Map<string, NativeCardContent>();
    const contentRows = await this.client.query('SELECT * FROM sei.native_card_versions WHERE owner_id=$1', [this.ownerId]);
    for (const row of contentRows.rows) {
      const card = NativeCardContentSchema.parse(row.snapshot_json);
      if (row.card_id !== card.id || row.fingerprint !== nativeContentVersion(card)) throw new Error('Native card content identity mismatch');
      contents.set(`${card.id}:${row.fingerprint}`, card);
    }
    const projections = new Map<string, NativeProjection>();
    for (const event of await this.history()) {
      const config = configs.get(event.configHash), content = contents.get(`${event.cardId}:${event.cardFingerprint}`);
      if (!config || !same(config, event.config) || event.config.hash !== event.configHash || !content || !same(content, event.cardSnapshot))
        throw new Error('Native event has inconsistent configuration/content references');
      const before = projections.get(event.cardId);
      let expected: { after: NativeProjection; log: NativeEvent['log'] };
      if (event.kind === 'init') {
        if (before || event.version !== 1 || event.before !== null || event.request !== null || event.requestHash !== null) throw new Error('Invalid native initialization chain');
        expected = { after: { cardId: event.cardId, version: 1, cardFingerprint: event.cardFingerprint,
          cardSnapshot: event.cardSnapshot, suspended: false, schedule: initialNativeCard(new Date(event.serverNow)), serverUpdatedAt: event.serverNow }, log: null };
      } else {
        if (!before || !same(before, event.before) || event.version !== before.version + 1 || !event.request ||
          event.requestHash !== hashNative(event.request) || event.request.cardId !== event.cardId ||
          event.request.expectedVersion !== before.version || event.request.cardFingerprint !== event.cardFingerprint ||
          Date.parse(event.serverNow) < Date.parse(before.serverUpdatedAt)) throw new Error('Invalid native event chain');
        this.validateClock(event.request, before, event.serverNow);
        expected = event.kind === 'review'
          ? this.reviewTransition(before, content, NativeReviewSchema.parse(event.request), event.serverNow, config)
          : this.controlTransition(before, content, NativeControlSchema.parse(event.request), event.serverNow, config);
      }
      if (!same(expected.after, event.after) || !same(expected.log, event.log)) throw new Error('Native replay differs from recorded library state/log');
      projections.set(event.cardId, expected.after);
    }
    // Every projection references an immutable event, so replay covers every card.
    // Upserts repair caches without granting the app DELETE or TRUNCATE privileges.
    for (const projection of projections.values()) await this.saveProjection(projection);
    return [...projections.values()];
  }
}
