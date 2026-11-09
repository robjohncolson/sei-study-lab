import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Catalog } from '../../../packages/shared/src/index.js';
import {
  NativeCardContentSchema, NativeControlSchema, NativeHashSchema, NativeInstantSchema,
  NativeLibraryCardSchema, NativeLibraryLogSchema, NativeReviewSchema, NativeSchedulerConfigSchema,
  type NativeCardContent, type NativeControlInput, type NativeQueue, type NativeQueueItem,
  type NativeReceipt, type NativeReviewInput, type NativeSchedulerConfig,
} from '../../../packages/shared/src/native-fsrs.js';
import {
  canonicalJson, currentNativeConfig, forgetNative, hashNative, initialNativeCard,
  nativeClock, nativeContentVersion, scheduleNative, validateNativeConfig,
} from './native-scheduler.js';

const ProjectionSchema = z.object({
  cardId: z.string().min(1).max(200), version: z.number().int().positive(),
  cardFingerprint: NativeHashSchema, cardSnapshot: NativeCardContentSchema,
  suspended: z.boolean(), schedule: NativeLibraryCardSchema, serverUpdatedAt: NativeInstantSchema,
}).strict();
export type NativeProjection = z.infer<typeof ProjectionSchema>;
const EventSchema = z.object({
  schemaVersion: z.literal(1), id: z.string().uuid(), kind: z.enum(['init', 'review', 'control']),
  cardId: z.string().min(1).max(200), version: z.number().int().positive(),
  cardFingerprint: NativeHashSchema, cardSnapshot: NativeCardContentSchema,
  config: NativeSchedulerConfigSchema, configHash: NativeHashSchema,
  serverNow: NativeInstantSchema,
  request: z.union([NativeReviewSchema, NativeControlSchema]).nullable(),
  requestHash: NativeHashSchema.nullable(),
  before: ProjectionSchema.nullable(), after: ProjectionSchema,
  log: NativeLibraryLogSchema.nullable(),
}).strict();
export type NativeEvent = z.infer<typeof EventSchema>;

/** Domain errors preserve 409 conflicts through the existing Fastify error boundary. */
export class NativeStoreError extends Error {
  constructor(message: string, readonly statusCode: 400 | 409 = 409) { super(message); }
}
const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);
const ordinal = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const clockAllowanceMs = 5 * 60 * 1000;

/** Local adapter: immutable events own history; projections are disposable caches. */
export class NativeStore {
  constructor(
    readonly db: DatabaseSync,
    readonly catalog: Pick<Catalog, 'cards'>,
    readonly clock: () => Date = () => new Date(),
  ) {
    if (!db.prepare('SELECT version FROM schema_migrations WHERE version=3').get()) {
      this.transaction(() => {
        db.exec(readFileSync(resolve(process.cwd(), 'apps/server/src/migrations/003-native-flashcards.sql'), 'utf8'));
        db.prepare('INSERT INTO schema_migrations(version,applied_at) VALUES(3,?)').run(this.now());
      });
    }
    this.transaction(() => this.saveConfig(currentNativeConfig()));
    this.rebuild();
  }

  private now() { return nativeClock(this.clock()); }
  private transaction<T>(operation: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = operation(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private saveConfig(raw: NativeSchedulerConfig) {
    const config = validateNativeConfig(raw);
    const existing = this.db.prepare('SELECT entity_json FROM native_scheduler_configs WHERE hash=?').get(config.hash);
    if (existing) {
      if (!same(JSON.parse(String(existing.entity_json)), config)) throw new Error('Native configuration hash conflict');
    } else this.db.prepare('INSERT INTO native_scheduler_configs(hash,entity_json) VALUES(?,?)').run(config.hash, canonicalJson(config));
    return config;
  }
  private saveContent(card: NativeCardContent) {
    const fingerprint = nativeContentVersion(card);
    const existing = this.db.prepare('SELECT snapshot_json FROM native_card_versions WHERE card_id=? AND fingerprint=?').get(card.id, fingerprint);
    if (existing) {
      if (!same(JSON.parse(String(existing.snapshot_json)), card)) throw new Error('Native content fingerprint conflict');
    } else this.db.prepare('INSERT INTO native_card_versions(card_id,fingerprint,snapshot_json) VALUES(?,?,?)').run(card.id, fingerprint, canonicalJson(card));
    return fingerprint;
  }
  private projection(cardId: string): NativeProjection | undefined {
    const row = this.db.prepare('SELECT entity_json FROM native_flashcard_projections WHERE card_id=?').get(cardId);
    return row ? ProjectionSchema.parse(JSON.parse(String(row.entity_json))) : undefined;
  }
  private saveProjection(projection: NativeProjection) {
    this.db.prepare('INSERT INTO native_flashcard_projections(card_id,version,entity_json) VALUES(?,?,?) ON CONFLICT(card_id) DO UPDATE SET version=excluded.version,entity_json=excluded.entity_json')
      .run(projection.cardId, projection.version, canonicalJson(projection));
  }
  private append(event: NativeEvent) {
    EventSchema.parse(event);
    this.saveConfig(event.config);
    this.saveContent(event.cardSnapshot);
    this.db.prepare('INSERT INTO native_flashcard_events(id,event_version,client_event_id,request_hash,card_id,projection_version,kind,config_hash,fingerprint,occurred_at,event_hash,entity_json) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(event.id, event.schemaVersion, event.request?.clientEventId ?? null, event.requestHash,
        event.cardId, event.version, event.kind, event.configHash, event.cardFingerprint,
        event.serverNow, hashNative(event), canonicalJson(event));
    this.saveProjection(event.after);
  }
  private decodeEvent(row: Record<string, unknown>) {
    const event = EventSchema.parse(JSON.parse(String(row.entity_json)));
    if (hashNative(event) !== row.event_hash || event.id !== row.id || event.cardId !== row.card_id ||
      event.version !== row.projection_version || event.kind !== row.kind || event.configHash !== row.config_hash ||
      event.cardFingerprint !== row.fingerprint || event.serverNow !== row.occurred_at ||
      event.schemaVersion !== row.event_version || event.requestHash !== row.request_hash ||
      (event.request?.clientEventId ?? null) !== row.client_event_id) throw new Error('Native event identity/hash mismatch');
    return event;
  }
  history(cardId?: string): NativeEvent[] {
    const rows = cardId === undefined
      ? this.db.prepare('SELECT * FROM native_flashcard_events ORDER BY sequence').all()
      : this.db.prepare('SELECT * FROM native_flashcard_events WHERE card_id=? ORDER BY projection_version').all(cardId);
    return rows.map(row => this.decodeEvent(row));
  }
  hasHistory() { return Boolean(this.db.prepare('SELECT 1 FROM native_flashcard_events LIMIT 1').get()); }
  private receipt(event: NativeEvent): NativeReceipt {
    if (!event.request) throw new Error('Initialization has no client receipt');
    return { clientEventId: event.request.clientEventId, eventId: event.id, cardId: event.cardId,
      version: event.version, cardFingerprint: event.cardFingerprint, schedule: event.after.schedule,
      suspended: event.after.suspended, serverNow: event.serverNow };
  }
  private duplicate(request: NativeReviewInput | NativeControlInput, kind: 'review' | 'control') {
    const row = this.db.prepare('SELECT * FROM native_flashcard_events WHERE client_event_id=?').get(request.clientEventId);
    if (!row) return undefined;
    const event = this.decodeEvent(row);
    if (event.kind !== kind || event.requestHash !== hashNative(request) || !same(event.request, request))
      throw new NativeStoreError('This client event ID already belongs to a different payload. Preserve the pending response.');
    return this.receipt(event);
  }
  private activeCard(cardId: string) {
    const cards = this.catalog.cards.filter(card => card.id === cardId);
    if (cards.length !== 1) throw new NativeStoreError('Card is missing, retired, or has an ambiguous identity. Its history is preserved.');
    return NativeCardContentSchema.parse(cards[0]);
  }
  private validateBase(request: NativeReviewInput | NativeControlInput, now: string) {
    const card = this.activeCard(request.cardId);
    const fingerprint = nativeContentVersion(card);
    const before = this.projection(request.cardId);
    if (!before || before.version !== request.expectedVersion) throw new NativeStoreError('Card state changed. Preserve the pending response and recover it explicitly.');
    if (fingerprint !== request.cardFingerprint) throw new NativeStoreError('Card content changed. Preserve the old response and review the current card deliberately.');
    this.validateClock(request, before, now);
    return { card, fingerprint, before };
  }
  private validateClock(request: NativeReviewInput | NativeControlInput, before: NativeProjection, now: string) {
    if (Date.parse(now) < Date.parse(before.serverUpdatedAt)) throw new NativeStoreError('Server clock moved backwards; review was not recorded.', 400);
    // An old frozen request is allowed after offline delay. Its original clock cannot
    // precede the acknowledged server version or be over five minutes in the future.
    if (Date.parse(request.clientNow) < Date.parse(before.serverUpdatedAt) - clockAllowanceMs ||
      Date.parse(request.clientNow) > Date.parse(now) + clockAllowanceMs)
      throw new NativeStoreError('Client clock is outside the acknowledged server time window. The pending response is preserved.', 400);
  }
  private reviewTime(request: NativeReviewInput, before: NativeProjection, now: string) {
    const started = Date.parse(request.startedAt), revealed = Date.parse(request.revealedAt), submitted = Date.parse(request.clientNow);
    if (started > revealed || revealed > submitted || started < Date.parse(before.serverUpdatedAt) - clockAllowanceMs)
      throw new NativeStoreError('Invalid review/reveal chronology; review was not recorded.', 400);
    if (Date.parse(before.schedule.due) > Date.parse(now)) throw new NativeStoreError('Card is not due. Preserve this pending review for explicit recovery.');
  }
  private nextProjection(before: NativeProjection, card: NativeCardContent, now: string): NativeProjection {
    return { ...before, cardId: card.id, version: before.version + 1, cardFingerprint: nativeContentVersion(card), cardSnapshot: card, serverUpdatedAt: now };
  }
  private reviewTransition(before: NativeProjection, card: NativeCardContent, request: NativeReviewInput, now: string, config: NativeSchedulerConfig) {
    if (before.suspended) throw new NativeStoreError('Suspended cards must be resumed before review.');
    if (before.cardFingerprint !== request.cardFingerprint) throw new NativeStoreError('Acknowledge the changed content with Keep, Reset, or Suspend before reviewing.');
    this.reviewTime(request, before, now);
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
  review(raw: unknown): NativeReceipt {
    const request = NativeReviewSchema.parse(raw);
    return this.transaction(() => {
      const duplicate = this.duplicate(request, 'review');
      if (duplicate) return duplicate;
      const now = this.now(), { card, fingerprint, before } = this.validateBase(request, now), config = currentNativeConfig();
      const transition = this.reviewTransition(before, card, request, now, config);
      const event: NativeEvent = { schemaVersion: 1, id: randomUUID(), kind: 'review', cardId: card.id,
        version: transition.after.version, cardFingerprint: fingerprint, cardSnapshot: card, config,
        configHash: config.hash, serverNow: now, request, requestHash: hashNative(request), before, ...transition };
      this.append(event);
      return this.receipt(event);
    });
  }
  control(raw: unknown): NativeReceipt {
    const request = NativeControlSchema.parse(raw);
    return this.transaction(() => {
      const duplicate = this.duplicate(request, 'control');
      if (duplicate) return duplicate;
      const now = this.now(), { card, fingerprint, before } = this.validateBase(request, now), config = currentNativeConfig();
      const transition = this.controlTransition(before, card, request, now, config);
      const event: NativeEvent = { schemaVersion: 1, id: randomUUID(), kind: 'control', cardId: card.id,
        version: transition.after.version, cardFingerprint: fingerprint, cardSnapshot: card, config,
        configHash: config.hash, serverNow: now, request, requestHash: hashNative(request), before, ...transition };
      this.append(event);
      return this.receipt(event);
    });
  }
  /** Explicit enrollment command; safe queue reads never create history. */
  initialize(): { initialized: number } {
    return this.transaction(() => {
      const now = this.now(), config = currentNativeConfig();
      let initialized = 0;
      const seen = new Set<string>();
      for (const raw of this.catalog.cards) {
        const card = NativeCardContentSchema.parse(raw);
        if (seen.has(card.id)) throw new Error('Duplicate native card ID');
        seen.add(card.id);
        if (this.projection(card.id)) continue;
        if (this.db.prepare('SELECT 1 FROM native_flashcard_events WHERE card_id=?').get(card.id)) throw new Error('Native projection missing; rebuild before continuing');
        const fingerprint = nativeContentVersion(card);
        const after: NativeProjection = { cardId: card.id, version: 1, cardFingerprint: fingerprint,
          cardSnapshot: card, suspended: false, schedule: initialNativeCard(new Date(now)), serverUpdatedAt: now };
        this.append({ schemaVersion: 1, id: randomUUID(), kind: 'init', cardId: card.id, version: 1,
          cardFingerprint: fingerprint, cardSnapshot: card, config, configHash: config.hash, serverNow: now,
          request: null, requestHash: null, before: null, after, log: null });
        initialized++;
      }
      return { initialized };
    });
  }

  queue(limit = 50): NativeQueue {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new NativeStoreError('Queue limit must be 1–100.', 400);
    const now = this.now(), config = currentNativeConfig();
    const cards = new Map<string, NativeCardContent>();
    for (const raw of this.catalog.cards) {
      const card = NativeCardContentSchema.parse(raw);
      if (cards.has(card.id)) throw new Error('Duplicate native card ID');
      cards.set(card.id, card);
      if (!this.projection(card.id) && this.db.prepare('SELECT 1 FROM native_flashcard_events WHERE card_id=?').get(card.id))
        throw new Error('Native projection missing; rebuild before continuing');
    }
    const items: NativeQueueItem[] = this.db.prepare('SELECT entity_json FROM native_flashcard_projections ORDER BY card_id').all().map(row => {
      const projection = ProjectionSchema.parse(JSON.parse(String(row.entity_json)));
      const current = cards.get(projection.cardId);
      const card = current ? NativeCardContentSchema.parse(current) : projection.cardSnapshot;
      const fingerprint = nativeContentVersion(card);
      return { card, cardFingerprint: fingerprint, acknowledgedFingerprint: projection.cardFingerprint,
        version: projection.version, suspended: projection.suspended, stale: fingerprint !== projection.cardFingerprint,
        missing: !current, schedule: projection.schedule };
    });
    const available = items.filter(item => !item.stale && !item.suspended && !item.missing);
    const due = available.filter(item => Date.parse(item.schedule.due) <= Date.parse(now));
    const learningFirst = (item: NativeQueueItem) => item.schedule.state === 1 || item.schedule.state === 3 ? 0 : 1;
    due.sort((a, b) => learningFirst(a) - learningFirst(b) || ordinal(a.schedule.due, b.schedule.due) || ordinal(a.card.id, b.card.id));
    const future = available.filter(item => Date.parse(item.schedule.due) > Date.parse(now)).map(item => item.schedule.due).sort();
    return { serverNow: now, config, reviewsSynchronized: false, queue: due.slice(0, limit),
      held: items.filter(item => item.stale || item.suspended || item.missing), nextDue: future[0] ?? null };
  }

  /** No catalog or current clock participates: init and control anchors are events. */
  rebuild(): NativeProjection[] {
    return this.transaction(() => {
      const configs = new Map<string, NativeSchedulerConfig>();
      for (const row of this.db.prepare('SELECT * FROM native_scheduler_configs').all()) {
        const config = validateNativeConfig(JSON.parse(String(row.entity_json)));
        if (row.hash !== config.hash) throw new Error('Native scheduler configuration identity mismatch');
        configs.set(config.hash, config);
      }
      const contents = new Map<string, NativeCardContent>();
      for (const row of this.db.prepare('SELECT * FROM native_card_versions').all()) {
        const card = NativeCardContentSchema.parse(JSON.parse(String(row.snapshot_json)));
        if (row.card_id !== card.id || row.fingerprint !== nativeContentVersion(card)) throw new Error('Native card content identity mismatch');
        contents.set(`${card.id}:${row.fingerprint}`, card);
      }
      const projections = new Map<string, NativeProjection>();
      for (const event of this.history()) {
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
          if (event.kind === 'review') {
            const request = NativeReviewSchema.parse(event.request);
            expected = this.reviewTransition(before, content, request, event.serverNow, config);
          } else {
            const request = NativeControlSchema.parse(event.request);
            expected = this.controlTransition(before, content, request, event.serverNow, config);
          }
        }
        if (!same(expected.after, event.after) || !same(expected.log, event.log)) throw new Error('Native replay differs from recorded library state/log');
        projections.set(event.cardId, expected.after);
      }
      this.db.exec('DELETE FROM native_flashcard_projections');
      for (const projection of projections.values()) this.saveProjection(projection);
      return [...projections.values()];
    });
  }
}
