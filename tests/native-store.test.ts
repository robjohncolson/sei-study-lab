import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createEmptyCard, fsrs, Rating } from 'ts-fsrs';
import {
  type NativeCardContent, type NativeControlInput, type NativeQueueItem, type NativeReviewInput,
} from '../packages/shared/src/native-fsrs.js';
import { NativeStore, NativeStoreError } from '../apps/server/src/native-store.js';
import { canonicalJson, deserializeNativeCard, deserializeNativeLog, nativeContentVersion } from '../apps/server/src/native-scheduler.js';

const t0 = '2026-11-09T00:00:00.000Z';
const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function setup(ids = ['card-a', 'card-b', 'card-c'], initialize = true) {
  const db = new DatabaseSync(':memory:');
  databases.push(db);
  db.exec('PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL);');
  const catalog = { cards: ids.map(id => ({ id, front: `Synthetic front ${id}`, back: `Synthetic back ${id}`, source: 'Synthetic source', tags: ['synthetic'] })) };
  let time = t0;
  const clock = () => new Date(time);
  const store = new NativeStore(db, catalog, clock);
  if (initialize) store.initialize();
  return { db, catalog, store, clock, advance: (value: string) => { time = value; } };
}
function review(item: NativeQueueItem, changes: Partial<NativeReviewInput> = {}): NativeReviewInput {
  return { clientEventId: randomUUID(), cardId: item.card.id, cardFingerprint: item.cardFingerprint,
    expectedVersion: item.version, response: '  naïve\n\t漢字 👩🏽‍🏫 e\u0301  ', assistance: ['consulted personal notes'],
    hintCount: 1, rating: 3, revealed: true, startedAt: t0, revealedAt: t0, clientNow: t0, ...changes };
}
function control(item: NativeQueueItem, action: NativeControlInput['action'], changes: Partial<NativeControlInput> = {}): NativeControlInput {
  return { clientEventId: randomUUID(), cardId: item.card.id, cardFingerprint: item.cardFingerprint,
    expectedVersion: item.version, clientNow: t0, action, ...changes };
}
function readProjection(db: DatabaseSync, id: string) {
  return String(db.prepare('SELECT entity_json FROM native_flashcard_projections WHERE card_id=?').get(id)?.entity_json);
}

describe('native immutable flashcard storage', () => {
  it('keeps empty and enrolled queue reads free of database writes', () => {
    const { db, store } = setup(['card-a'], false);
    const tables = ['native_flashcard_events', 'native_flashcard_projections', 'native_card_versions', 'native_scheduler_configs'];
    const snapshot = () => tables.map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const empty = snapshot();
    // query_only also rejects accidental writes to disposable projections or metadata.
    db.exec('PRAGMA query_only=ON');
    expect(store.queue().queue).toEqual([]);
    expect(store.queue().held).toEqual([]);
    expect(store.queue().summary).toEqual({ initialized: false, total: 0, due: 0, new: 0, learning: 0, review: 0, held: 0 });
    expect(store.history()).toEqual([]);
    expect(store.hasHistory()).toBe(false);
    expect(snapshot()).toEqual(empty);
    db.exec('PRAGMA query_only=OFF');
    expect(store.initialize()).toEqual({ initialized: 1 });
    const enrolled = snapshot();
    db.exec('PRAGMA query_only=ON');
    expect(store.queue().queue).toHaveLength(1);
    expect(store.queue().queue[0].version).toBe(1);
    expect(store.queue().summary).toEqual({ initialized: true, total: 1, due: 1, new: 1, learning: 0, review: 0, held: 0 });
    expect(snapshot()).toEqual(enrolled);
  });

  it('summarizes all available FSRS states and held cards before limiting the read-only queue', () => {
    const { db, store, catalog, advance } = setup(['new', 'learning', 'review', 'relearning', 'stale', 'suspended', 'missing']);
    const initial = store.queue().queue;
    const item = (id: string) => initial.find(entry => entry.card.id === id)!;
    store.review(review(item('learning'), { rating: 1 }));
    store.review(review(item('review'), { rating: 4 }));
    store.review(review(item('relearning'), { rating: 4 }));
    store.control(control(item('suspended'), 'suspend'));
    catalog.cards.find(card => card.id === 'stale')!.front = 'Changed synthetic front';
    catalog.cards.splice(catalog.cards.findIndex(card => card.id === 'missing'), 1);
    const later = '2026-11-25T00:00:00.000Z';
    advance(later);
    const relearning = store.queue().queue.find(entry => entry.card.id === 'relearning')!;
    const receipt = store.review(review(relearning, { rating: 1, startedAt: later, revealedAt: later, clientNow: later }));
    expect(receipt.schedule.state).toBe(3);
    advance('2026-11-26T00:00:00.000Z');
    const snapshot = () => ['native_flashcard_events', 'native_flashcard_projections', 'native_card_versions', 'native_scheduler_configs']
      .map(table => db.prepare(`SELECT * FROM ${table}`).all());
    const before = snapshot();
    db.exec('PRAGMA query_only=ON');
    const result = store.queue(1);
    expect(result.queue).toHaveLength(1);
    expect(result.summary).toEqual({ initialized: true, total: 7, due: 4, new: 1, learning: 2, review: 1, held: 3 });
    expect(snapshot()).toEqual(before);
  });

  it('enrolls each new catalog card only on an explicit idempotent initialization', () => {
    const { store, catalog, advance } = setup(['card-a'], false);
    expect(store.initialize()).toEqual({ initialized: 1 });
    const original = store.history();
    advance('2026-11-12T12:00:00.000Z');
    expect(store.initialize()).toEqual({ initialized: 0 });
    expect(store.history()).toEqual(original);
    catalog.cards.push({ ...catalog.cards[0], id: 'card-b' });
    expect(store.queue().queue.map(item => item.card.id)).toEqual(['card-a']);
    expect(store.history()).toEqual(original);
    expect(store.initialize()).toEqual({ initialized: 1 });
    expect(store.initialize()).toEqual({ initialized: 0 });
    expect(store.history().map(event => [event.cardId, event.kind, event.version, event.serverNow])).toEqual([
      ['card-a', 'init', 1, t0], ['card-b', 'init', 1, '2026-11-12T12:00:00.000Z'],
    ]);
    expect(store.history()[0]).toEqual(original[0]);
    const enrolled = store.queue();
    store.rebuild();
    expect(store.initialize()).toEqual({ initialized: 0 });
    expect(store.queue()).toEqual(enrolled);
  });

  it('records one init anchor and rebuilds/reopens without moving the new-card due time', () => {
    const { db, store, catalog, clock, advance } = setup();
    const original = store.queue();
    expect(original.queue.map(item => item.card.id)).toEqual(['card-a', 'card-b', 'card-c']);
    expect(original.queue.every(item => item.schedule.due === t0)).toBe(true);
    expect(original.reviewsSynchronized).toBe(false);
    const projection = readProjection(db, 'card-a');
    advance('2026-11-12T12:00:00.000Z');
    expect(store.queue().queue[0].schedule.due).toBe(t0);
    expect(store.history()).toHaveLength(3);
    db.exec('DELETE FROM native_flashcard_projections');
    const reopened = new NativeStore(db, catalog, clock);
    expect(readProjection(db, 'card-a')).toBe(projection);
    expect(reopened.queue().queue[0].schedule.due).toBe(t0);
    expect(reopened.history()).toHaveLength(3);
  });

  it('preserves exact response/help and both full library states/log; no evidence is promoted', () => {
    const { db, store } = setup(['card-a']);
    db.exec("CREATE TABLE evidence_events(id TEXT PRIMARY KEY,entity_json TEXT); INSERT INTO evidence_events VALUES('existing','unchanged');");
    const item = store.queue().queue[0], payload = review(item);
    const receipt = store.review(payload), event = store.history('card-a')[1];
    expect(receipt.schedule).toMatchObject({ due: '2026-11-09T00:10:00.000Z', state: 1, reps: 1, learning_steps: 1, stability: 2.3065, difficulty: 2.11810397 });
    expect(event.request).toEqual(payload);
    expect(event.before?.schedule).toEqual(item.schedule);
    expect(event.after.schedule).toEqual(receipt.schedule);
    expect(event.log).toMatchObject({ rating: 3, state: 0, due: t0, review: t0 });
    expect(event.config).toMatchObject({ library: 'ts-fsrs', libraryVersion: '5.4.2', model: 'FSRS-6', parameters: { enable_fuzz: false, request_retention: 0.9 } });
    expect(event.configHash).toBe(event.config.hash);
    expect(event.cardSnapshot).toEqual(item.card);
    expect(event.cardFingerprint).toBe(nativeContentVersion(item.card));
    expect(db.prepare('SELECT * FROM evidence_events').all()).toEqual([{ id: 'existing', entity_json: 'unchanged' }]);
    const original = readProjection(db, 'card-a');
    store.rebuild();
    expect(readProjection(db, 'card-a')).toBe(original);
  });

  it('returns the original receipt after newer events/content and rejects ID reuse with any changed payload', () => {
    const { store, catalog } = setup(['card-a']);
    const item = store.queue().queue[0], payload = review(item), receipt = store.review(payload);
    store.control(control({ ...item, version: receipt.version }, 'suspend'));
    catalog.cards[0].front = 'New synthetic wording';
    const before = store.history();
    expect(store.review(payload)).toEqual(receipt);
    expect(store.history()).toEqual(before);
    expect(() => store.review({ ...payload, response: `${payload.response} ` })).toThrow(/different payload/);
    expect(() => store.control({ clientEventId: payload.clientEventId, cardId: item.card.id, cardFingerprint: item.cardFingerprint, expectedVersion: 1, clientNow: t0, action: 'keep' })).toThrow(/different payload/);
    expect(store.history()).toEqual(before);
  });

  it('serializes competing expected versions: a stale submission adds neither event nor projection mutation', () => {
    const { db, store } = setup(['card-a']);
    const item = store.queue().queue[0];
    store.review(review(item));
    const before = readProjection(db, item.card.id), events = store.history();
    try { store.review(review(item, { rating: 4 })); throw new Error('Expected conflict'); }
    catch (error) { expect(error).toBeInstanceOf(NativeStoreError); expect((error as NativeStoreError).statusCode).toBe(409); }
    expect(readProjection(db, item.card.id)).toBe(before);
    expect(store.history()).toEqual(events);
    expect(() => store.control(control(item, 'suspend'))).toThrow(/state changed/);
    expect(store.history()).toEqual(events);
  });

  it('rolls the event back when the projection write fails', () => {
    const { db, store } = setup(['card-a']);
    const item = store.queue().queue[0], before = readProjection(db, item.card.id), events = store.history();
    db.exec("CREATE TRIGGER synthetic_projection_failure BEFORE UPDATE ON native_flashcard_projections BEGIN SELECT RAISE(ABORT,'Synthetic failure'); END;");
    expect(() => store.review(review(item))).toThrow(/Synthetic failure/);
    expect(store.history()).toEqual(events);
    expect(readProjection(db, item.card.id)).toBe(before);
  });

  it('enforces UPDATE and DELETE triggers for events, configurations, and content versions', () => {
    const { db, store } = setup(['card-a']);
    store.review(review(store.queue().queue[0]));
    for (const table of ['native_flashcard_events', 'native_scheduler_configs', 'native_card_versions']) {
      expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(/Append-only/);
      const column = table === 'native_card_versions' ? 'snapshot_json' : 'entity_json';
      expect(() => db.exec(`UPDATE ${table} SET ${column}=${column}`)).toThrow(/Append-only/);
    }
  });

  it('orders learning before other due cards, then due instant/card ID, and uses actual overdue review time', () => {
    const { store, advance } = setup(['card-b', 'card-a', 'card-c']);
    let queue = store.queue().queue;
    store.review(review(queue.find(item => item.card.id === 'card-c')!, { rating: 1 }));
    store.review(review(queue.find(item => item.card.id === 'card-b')!, { rating: 4 }));
    advance('2026-11-25T12:00:00.000Z');
    queue = store.queue().queue;
    expect(queue.map(item => item.card.id)).toEqual(['card-c', 'card-a', 'card-b']);
    expect(store.queue(2).queue).toHaveLength(2);
    const receipt = store.review(review(queue[0], { startedAt: '2026-11-25T12:00:00.000Z', revealedAt: '2026-11-25T12:00:00.000Z', clientNow: '2026-11-25T12:00:00.000Z' }));
    const event = store.history('card-c').at(-1)!;
    expect(event.log?.review).toBe('2026-11-25T12:00:00.000Z');
    expect(receipt.schedule.last_review).toBe('2026-11-25T12:00:00.000Z');
    expect(Date.parse(receipt.schedule.due)).toBeGreaterThan(Date.parse(receipt.serverNow));
    expect(() => store.queue(0)).toThrow(/Queue limit/);
    expect(() => store.queue(101)).toThrow(/Queue limit/);
    expect(() => store.queue(Number.NaN)).toThrow(/Queue limit/);
  });

  it('excludes future/suspended cards and restores suspended cards through an explicit control', () => {
    const { store } = setup(['card-a', 'card-b']);
    const items = store.queue().queue;
    const reviewed = store.review(review(items[0], { rating: 4 }));
    expect(store.queue().nextDue).toBe('2026-11-17T00:00:00.000Z');
    const payload = control(items[1], 'suspend'), receipt = store.control(payload);
    expect(store.control(payload)).toEqual(receipt);
    expect(store.queue().queue).toHaveLength(0);
    const suspended = store.queue().held[0];
    expect(() => store.review(review(suspended))).toThrow(/Suspended/);
    store.control(control(suspended, 'resume'));
    expect(store.queue().queue.map(item => item.card.id)).toEqual(['card-b']);
    expect(store.history('card-a').at(-1)?.after.schedule).toEqual(reviewed.schedule);
  });

  it('blocks stale content and Keep acknowledges new content without changing the schedule or original answer', () => {
    const { db, store, catalog } = setup(['card-a']);
    const original = store.queue().queue[0], response = review(original), receipt = store.review(response);
    catalog.cards[0].front = 'Revised synthetic front';
    const stale = store.queue().held[0];
    expect(stale.stale).toBe(true);
    expect(store.queue().queue).toHaveLength(0);
    expect(() => store.review(review(stale))).toThrow(/Acknowledge/);
    expect(() => store.control(control({ ...stale, cardFingerprint: original.cardFingerprint }, 'keep'))).toThrow(/content changed/);
    const keep = store.control(control(stale, 'keep'));
    expect(keep.schedule).toEqual(receipt.schedule);
    expect(store.queue().held).toHaveLength(0);
    expect(store.history()[1].request).toEqual(response);
    expect(store.history()[1].cardSnapshot.front).toBe(original.card.front);
    expect(store.history()[2].cardSnapshot.front).toBe(catalog.cards[0].front);
    const before = readProjection(db, original.card.id);
    store.rebuild();
    expect(readProjection(db, original.card.id)).toBe(before);
  });

  it('records official reset output, acknowledges suspension, and retains missing-card history', () => {
    const { db, store, catalog, advance } = setup(['card-a']);
    store.review(review(store.queue().queue[0], { rating: 4 }));
    catalog.cards[0].back = 'Revised synthetic back';
    const stale = store.queue().held[0];
    advance('2026-11-10T00:00:00.000Z');
    const reset = store.control(control(stale, 'reset', { clientNow: '2026-11-10T00:00:00.000Z' }));
    expect(reset.schedule).toMatchObject({ state: 0, reps: 0, lapses: 0, stability: 0, difficulty: 0, due: '2026-11-10T00:00:00.000Z' });
    expect(store.history().at(-1)?.log?.rating).toBe(0);
    catalog.cards[0].front = 'Another synthetic revision';
    store.control(control(store.queue().held[0], 'suspend', { clientNow: '2026-11-10T00:00:00.000Z' }));
    expect(store.queue().held[0]).toMatchObject({ stale: false, suspended: true });
    const before = readProjection(db, 'card-a'), history = store.history();
    catalog.cards.splice(0);
    const missing = store.queue().held[0];
    expect(missing.missing).toBe(true);
    expect(() => store.control(control(missing, 'resume', { clientNow: '2026-11-10T00:00:00.000Z' }))).toThrow(/missing/);
    expect(() => store.review(review(missing, { clientNow: '2026-11-10T00:00:00.000Z' }))).toThrow(/missing/);
    store.rebuild();
    expect(readProjection(db, 'card-a')).toBe(before);
    expect(store.history()).toEqual(history);
  });

  for (const [resetAt, scheduledDays] of [
    ['2026-11-10T00:00:00.000Z', -7],
    ['2026-11-20T00:00:00.000Z', 3],
  ] as const) {
    it(`roundtrips and replays the exact official reset at ${resetAt} without losing history`, () => {
      const { db, store, catalog, clock, advance } = setup(['card-a']);
      const item = store.queue().queue[0], payload = review(item, { rating: 4 });
      const reviewed = store.review(payload);
      const prior = store.history();
      const library = fsrs({ enable_fuzz: false });
      const officialReview = library.next(createEmptyCard(new Date(t0)), new Date(t0), Rating.Easy);
      expect(deserializeNativeCard(reviewed.schedule)).toEqual(officialReview.card);
      const expected = library.forget(officialReview.card, new Date(resetAt), true);
      advance(resetAt);
      const request = control({ ...item, version: reviewed.version }, 'reset', { clientNow: resetAt });
      const reset = store.control(request);
      const history = store.history(), event = history.at(-1)!;
      expect(history).toHaveLength(3);
      expect(history.slice(0, -1)).toEqual(prior);
      expect(history[1].request).toEqual(payload);
      expect(event.request).toEqual(request);
      expect(event.before?.schedule).toEqual(reviewed.schedule);
      expect(event.after.schedule).toEqual(reset.schedule);
      expect(deserializeNativeCard(reset.schedule)).toEqual(expected.card);
      expect(deserializeNativeLog(event.log!)).toEqual(expected.log);
      expect(event.log?.scheduled_days).toBe(scheduledDays);
      expect(event.log?.rating).toBe(Rating.Manual);
      expect(reset.schedule.scheduled_days).toBeGreaterThanOrEqual(0);
      expect(store.control(request)).toEqual(reset);
      expect(store.history()).toEqual(history);
      const projection = readProjection(db, 'card-a');
      store.rebuild();
      expect(readProjection(db, 'card-a')).toBe(projection);
      expect(store.history()).toEqual(history);
      const reopened = new NativeStore(db, catalog, clock);
      expect(readProjection(db, 'card-a')).toBe(projection);
      expect(reopened.history()).toEqual(history);
      expect(reopened.queue().queue[0].schedule).toEqual(reset.schedule);
    });
  }

  it('validates both write schemas, client chronology/skew, and server time without accepting client due dates', () => {
    const { store, advance } = setup(['card-a']);
    const item = store.queue().queue[0], valid = review(item), events = store.history();
    for (const invalid of [
      { ...valid, revealed: false }, { ...valid, rating: 0 }, { ...valid, rating: 5 }, { ...valid, rating: Number.NaN },
      { ...valid, hintCount: Number.POSITIVE_INFINITY }, { ...valid, clientNow: 'invalid' },
      { ...valid, dueAt: '2099-01-01T00:00:00.000Z' },
      { ...valid, clientNow: '2026-11-09T00:06:00.000Z' },
      { ...valid, startedAt: '2026-11-09T00:00:01.000Z' },
      { ...valid, startedAt: '2026-11-08T23:54:00.000Z' },
    ]) expect(() => store.review(invalid)).toThrow();
    expect(() => store.control({ ...control(item, 'keep'), action: 'delete' })).toThrow();
    expect(() => store.control(control(item, 'keep', { clientNow: '2026-11-09T00:06:00.000Z' }))).toThrow(/clock/);
    advance('2026-11-08T23:59:59.000Z');
    expect(() => store.review(valid)).toThrow(/backwards/);
    advance('invalid');
    expect(() => store.review(valid)).toThrow(/Invalid server review time/);
    expect(store.history()).toEqual(events);
  });

  it('keeps frozen offline responses and schedules at server receipt time, not the old client time', () => {
    const { store, advance } = setup(['card-a']);
    const payload = review(store.queue().queue[0], { rating: 1 });
    advance('2026-12-09T00:00:00.000Z');
    const receipt = store.review(payload);
    expect(receipt.schedule.due).toBe('2026-12-09T00:01:00.000Z');
    expect(store.history()[1].request).toEqual(payload);
    expect(store.review(payload)).toEqual(receipt);
  });

  it('rebuilds corrupted cached projections solely from immutable init/review/control records', () => {
    const { db, store } = setup(['card-a']);
    const item = store.queue().queue[0];
    store.review(review(item));
    const original = readProjection(db, 'card-a');
    db.prepare('UPDATE native_flashcard_projections SET entity_json=? WHERE card_id=?').run(canonicalJson({ malicious: true }), 'card-a');
    store.rebuild();
    expect(readProjection(db, 'card-a')).toBe(original);
  });

  it('does not mutate the caller catalog while snapshotting canonical content', () => {
    const { store, catalog } = setup(['card-a']);
    const original: NativeCardContent = structuredClone(catalog.cards[0]);
    store.queue();
    store.review(review(store.queue().queue[0]));
    expect(catalog.cards[0]).toEqual(original);
  });
});
