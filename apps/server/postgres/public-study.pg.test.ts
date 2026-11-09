import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Catalog } from '../../../packages/shared/src/index.js';
import { createHostedSeiServer } from '../src/hosted-app.js';
import { readHostedConfig } from '../src/hosted-config.js';
import { PostgresStudyStore } from '../src/postgres/study-store.js';
import { withOwnerTransaction } from '../src/postgres/transaction.js';
import { SeiStore } from '../src/store.js';
import { createPostgresHarness, type PostgresHarness } from './harness.js';

const origin = 'https://synthetic-study.example';
const host = 'synthetic-study.example';
const t0 = '2026-01-01T12:00:00.000Z';
const source = { id: 'synthetic.source', version: 1, url: 'https://example.org/synthetic', title: 'Synthetic fixture',
  retrievedAt: null, effectiveDate: null, sha256: null, excerpt: 'Synthetic source only', reviewState: 'source_compared' as const };
const mentor = { id: 'synthetic.mentor', version: 1, title: 'Synthetic mentor', discipline: 'Synthetic',
  text: 'Synthetic mentor text only.', originKind: 'authored_practice' as const, sha256: 'b'.repeat(64) };
function catalog(): Catalog {
  const mc: Catalog['tasks'][number] = { id: 'synthetic.mc', version: 1, kind: 'mc', title: 'Synthetic MC',
    prompt: 'Select the synthetic correct option.', options: [{ id: 'yes', text: 'Correct' }, { id: 'no', text: 'Incorrect' }],
    answerKey: { accepted: ['yes'], feedback: 'Synthetic correct feedback.', wrongFeedback: { no: 'Synthetic wrong feedback.' } },
    reviewState: 'source_checked', sourceRefs: [source.id], skillIds: ['synthetic.skill'], familyId: 'synthetic.family', noveltyKind: 'familiar' };
  return { schemaVersion: 1, sources: [source], objectives: [], statements: [], competencies: [], indicators: [],
    skills: [{ id: 'synthetic.skill', version: 1, title: 'Synthetic skill', status: 'source_checked' }],
    alignments: [], prerequisites: [], lessons: [], reviewEvents: [], mentorTexts: [mentor],
    rubrics: [{ id: 'synthetic.rubric', version: 1, sourceVersionId: source.id, criteria: [], scale: {} }],
    cards: [{ id: 'synthetic.card', front: 'Synthetic recall', back: 'Synthetic answer', source: source.url, tags: ['synthetic'] }],
    tasks: [mc, { ...mc, id: 'synthetic.sibling', noveltyKind: 'unfamiliar' },
      { ...mc, id: 'synthetic.other', familyId: 'synthetic.other-family' },
      { id: 'synthetic.writing', version: 1, kind: 'writing', title: 'Synthetic writing', prompt: 'Derived synthetic writing',
        reviewState: 'source_checked', sourceRefs: [source.id], skillIds: ['synthetic.skill'], familyId: 'synthetic.writing-family',
        noveltyKind: 'unfamiliar', mentorTextId: mentor.id, rubricVersionId: 'synthetic.rubric@1',
        parts: [1, 2, 3, 4, 5].map(n => ({ id: `part.${n}`, title: `Part ${n}`, prompt: 'Synthetic derived part' })) }] };
}
const body = { taskId: 'synthetic.mc', taskVersion: 1, answer: 'yes', hintCount: 0, assistance: [] as string[] };
const writing = () => ({ mentorTextId: mentor.id, mentorTextVersion: mentor.version, mentorTextHash: mentor.sha256,
  rubricVersionId: 'synthetic.rubric@1', parts: Object.fromEntries([1, 2, 3, 4, 5].map(n => [`part.${n}`, `  Original part ${n}\n`])) });
type StudyState = ReturnType<SeiStore['state']>;
function comparable(state: StudyState) {
  const identities = new Map<string, string>();
  for (const [prefix, rows] of [['attempt', state.attempts], ['judgment', state.judgments], ['evidence', state.evidenceEvents]] as const) {
    rows.forEach((row, index) => identities.set(row.id, `${prefix}-${index}`));
  }
  return JSON.parse(JSON.stringify(state, (key, value: unknown) => {
    if (['startedAt', 'submittedAt', 'createdAt', 'updatedAt', 'sessionId'].includes(key)) return undefined;
    if (key === 'eligibilityContextAttemptIds' && Array.isArray(value)) return value.map(id => identities.get(String(id))).sort();
    return typeof value === 'string' ? identities.get(value) ?? value : value;
  }));
}

describe('public hosted study routes on disposable real Postgres', () => {
  let harness: PostgresHarness;
  const apps: FastifyInstance[] = [];
  const stores: SeiStore[] = [];
  beforeAll(async () => { harness = await createPostgresHarness(); });
  afterAll(async () => {
    vi.useRealTimers();
    stores.splice(0).forEach(store => store.close());
    await Promise.all(apps.splice(0).map(app => app.close()));
    if (harness) await harness.dispose();
  });
  async function setup(owner = randomUUID(), content = catalog(), initialTime = t0) {
    let now = initialTime;
    const config = readHostedConfig({ STORAGE_MODE: 'postgres', HOSTED_AUTH_MODE: 'public', PUBLIC_OWNER_ID: owner,
      SEI_DATABASE_URL: harness.appUrl, APP_ORIGINS: origin, APP_HOSTS: host });
    const app = await createHostedSeiServer({ config, pool: harness.pool, catalog: content, clock: () => new Date(now) });
    apps.push(app);
    const session = await app.inject({ url: '/api/session', headers: { host } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toMatchObject({ storageMode: 'postgres', authMode: 'public' });
    expect(session.headers['set-cookie']).toBeUndefined();
    const token: string = session.json().csrfToken;
    const headers = { host, origin, 'x-csrf-token': token };
    return { app, owner, content, headers, token, advance: (instant: string) => { now = instant; } };
  }
  const run = <T>(owner: string, content: Catalog, fn: (store: PostgresStudyStore) => Promise<T>) =>
    withOwnerTransaction(harness.pool, { sub: owner, role: 'authenticated' }, client => fn(new PostgresStudyStore(client, owner, content, () => new Date(t0))));

  it('serves session/catalog/state/Anki with no login or cookies, and native flashcards still work', async () => {
    const { app, content, headers } = await setup();
    const received = await app.inject({ url: '/api/catalog', headers });
    expect(received.statusCode).toBe(200);
    expect(received.json()).toEqual(content);
    const state = await app.inject({ url: '/api/state', headers });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ attempts: [], judgments: [], evidenceEvents: [], drafts: [],
      taskVersions: content.tasks, anki: { mode: 'tsv', reviewsSynchronized: false }, models: { enabled: false, calls: 0 } });
    const anki = await app.inject({ url: '/api/anki.tsv', headers });
    expect(anki.statusCode).toBe(200);
    expect(anki.headers['content-type']).toContain('text/tab-separated-values');
    expect(anki.body).toContain('Synthetic recall');
    const init = await app.inject({ method: 'POST', url: '/api/native-flashcards/initialize', headers });
    expect(init.statusCode).toBe(200);
    expect(init.json()).toEqual({ initialized: 1 });
    const queue = (await app.inject({ url: '/api/native-flashcards', headers })).json();
    const item = queue.queue[0];
    const receipt = await app.inject({ method: 'POST', url: '/api/native-flashcards/reviews', headers, payload: {
      clientEventId: randomUUID(), cardId: item.card.id, cardFingerprint: item.cardFingerprint, expectedVersion: item.version,
      response: 'Synthetic recall response', assistance: [], hintCount: 0, rating: 3, revealed: true,
      startedAt: t0, revealedAt: t0, clientNow: t0,
    } });
    expect(receipt.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/native-flashcards/history', headers })).json()).toHaveLength(2);
  });

  it('matches SQLite judgments, policy v2 context, original answers and full state for the same sequence', async () => {
    const { app, headers, content, advance } = await setup();
    const local = new SeiStore(content, ':memory:');
    stores.push(local);
    const sequence = [
      { at: t0, input: body, eligible: true, status: 'correct' },
      { at: '2026-01-01T12:01:00.000Z', input: { ...body, taskId: 'synthetic.sibling', answer: 'no' }, eligible: false, status: 'incorrect' },
      { at: '2026-01-02T12:02:00.000Z', input: { ...body, answer: 'no', startedAt: '2026-01-02T12:02:00.000Z' }, eligible: true, status: 'incorrect' },
      { at: '2026-01-03T12:03:00.000Z', input: { ...body, hintCount: 1, startedAt: '2026-01-03T12:03:00.000Z' }, eligible: false, status: 'correct' },
      { at: '2026-01-04T12:04:00.000Z', input: { ...body, assistance: ['Synthetic notes'], startedAt: '2026-01-04T12:04:00.000Z' }, eligible: false, status: 'correct' },
      { at: '2026-01-05T12:05:00.000Z', input: { ...body, startedAt: '2026-01-05T12:05:00.000Z' }, eligible: true, status: 'correct' },
      { at: '2026-01-05T12:06:00.000Z', input: { ...body, taskId: 'synthetic.other', answer: 'no' }, eligible: true, status: 'incorrect' },
    ];
    for (const step of sequence) {
      advance(step.at);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(step.at);
      try { local.submit(step.input, `hosted-${step.at.slice(0, 10)}`); }
      finally { vi.useRealTimers(); }
      const response = await app.inject({ method: 'POST', url: '/api/attempts', headers, payload: step.input });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().judgment.result.status).toBe(step.status);
      expect(response.json().evidenceEvents[0]).toMatchObject({ eligible: step.eligible, eligibilityPolicyVersion: 2 });
      expect(response.json().attempt.originalAnswer).toEqual(step.input.answer);
      const hosted = (await app.inject({ url: '/api/state', headers })).json<StudyState>();
      expect(comparable(hosted)).toEqual(comparable(local.state()));
    }
    const hosted = (await app.inject({ url: '/api/state', headers })).json<StudyState>();
    expect(hosted.evidenceEvents[1].eligibilityContextAttemptIds).toEqual([hosted.attempts[0].id]);
    expect(hosted.evidenceEvents[1].exclusionReason).toContain('Feedback-dependent');
  });

  it('requires mentor identity and exactly five writing parts, retains drafts, and rejects stale versions', async () => {
    const { app, headers, owner, content } = await setup();
    const local = new SeiStore(content, ':memory:');
    stores.push(local);
    const answer = writing();
    const missingPart = { ...answer, parts: { ...answer.parts } };
    delete missingPart.parts['part.5'];
    for (const invalid of [null, { ...answer, mentorTextHash: 'wrong' }, missingPart,
      { ...answer, parts: { ...answer.parts, 'part.6': 'extra' } }]) {
      const response = await app.inject({ method: 'POST', url: '/api/attempts', headers,
        payload: { ...body, taskId: 'synthetic.writing', answer: invalid } });
      expect(response.statusCode).toBe(400);
      expect(() => local.submit({ ...body, taskId: 'synthetic.writing', answer: invalid }, 'synthetic')).toThrow();
    }
    expect((await app.inject({ url: '/api/state', headers })).json().attempts).toEqual([]);
    const draftPayload = { taskVersion: 1, answer: { ...answer, parts: { 'part.1': answer.parts['part.1'] } } };
    local.saveDraft('synthetic.writing', 1, draftPayload.answer);
    expect((await app.inject({ method: 'PUT', url: '/api/drafts/synthetic.writing', headers, payload: draftPayload })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/drafts/synthetic.writing', headers })).json()).toMatchObject({ answer: draftPayload.answer, taskVersion: '1', olderDrafts: [] });
    expect((await app.inject({ method: 'PUT', url: '/api/drafts/synthetic.writing', headers,
      payload: { ...draftPayload, taskVersion: 99 } })).statusCode).toBe(400);
    const submitted = await app.inject({ method: 'POST', url: '/api/attempts', headers, payload: { ...body, taskId: 'synthetic.writing', answer } });
    local.submit({ ...body, taskId: 'synthetic.writing', answer }, 'synthetic');
    expect(submitted.statusCode).toBe(200);
    expect(submitted.json()).toMatchObject({ attempt: { originalAnswer: answer }, judgment: { result: { status: 'needs_review' } } });
    expect(submitted.json().evidenceEvents[0].eligible).toBe(false);
    expect(comparable((await app.inject({ url: '/api/state', headers })).json<StudyState>())).toEqual(comparable(local.state()));
    const changed = structuredClone(content);
    changed.tasks.find(task => task.id === 'synthetic.writing')!.version = 2;
    const newer = await setup(owner, changed);
    const recovered = (await newer.app.inject({ url: '/api/drafts/synthetic.writing', headers: newer.headers })).json();
    expect(recovered).toMatchObject({ answer: null, taskVersion: '2', currentTaskVersion: '2', olderDrafts: [{ taskVersion: '1', answer: draftPayload.answer }] });
    const state = (await newer.app.inject({ url: '/api/state', headers: newer.headers })).json<StudyState>();
    expect(state.taskVersions.filter(task => task.id === 'synthetic.writing').map(task => task.version)).toEqual([1, 2]);
    expect((await newer.app.inject({ method: 'POST', url: '/api/attempts', headers: newer.headers,
      payload: { ...body, taskId: 'synthetic.writing', answer } })).statusCode).toBe(400);
  });

  it('preserves JSON string escapes accepted by SQLite in original answers and drafts', async () => {
    const content = catalog();
    content.tasks[0].kind = 'short';
    const { app, headers } = await setup(randomUUID(), content);
    const local = new SeiStore(content, ':memory:');
    stores.push(local);
    const original = '  Original \\u0000 escape: \u0000; lone surrogate: \ud800; text\n';
    for (const answer of [original, { original, parts: [original] }]) {
      const input = { ...body, answer };
      const submitted = await app.inject({ method: 'POST', url: '/api/attempts', headers, payload: input });
      expect(submitted.statusCode, submitted.body).toBe(200);
      expect(submitted.json().attempt.originalAnswer).toEqual(answer);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(t0);
      try { local.submit(input, 'synthetic'); }
      finally { vi.useRealTimers(); }
      local.saveDraft(body.taskId, body.taskVersion, answer);
      const saved = await app.inject({ method: 'PUT', url: `/api/drafts/${body.taskId}`, headers,
        payload: { taskVersion: body.taskVersion, answer } });
      expect(saved.statusCode, saved.body).toBe(200);
      expect((await app.inject({ url: `/api/drafts/${body.taskId}`, headers })).json().answer).toEqual(answer);
      expect(comparable((await app.inject({ url: '/api/state', headers })).json<StudyState>())).toEqual(comparable(local.state()));
    }
  });

  it('rejects Host/Origin/CSRF failures and keeps unsupported exchanges explicit without CORS', async () => {
    const { app, headers } = await setup();
    for (const badHeaders of [{ ...headers, host: 'evil.example' }, { ...headers, origin: 'https://evil.example' },
      { host, 'x-csrf-token': headers['x-csrf-token'] }, { host, origin }, { ...headers, 'x-csrf-token': 'wrong' }]) {
      const response = await app.inject({ method: 'POST', url: '/api/attempts', headers: badHeaders, payload: body });
      expect(response.statusCode).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
    expect((await app.inject({ url: '/api/state', headers: { host: 'evil.example' } })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/state', headers: { host, origin: 'https://evil.example' } })).statusCode).toBe(403);
    for (const url of ['/api/export', '/api/import', '/api/import/preview', '/api/handoff', '/api/proposals/preview', '/api/proposals/approve']) {
      const response = await app.inject({ method: url === '/api/export' ? 'GET' : 'POST', url, headers, payload: url === '/api/export' ? undefined : {} });
      expect(response.statusCode).toBe(501);
      expect(response.json().error).toContain('hosted');
    }
    const preflight = await app.inject({ method: 'OPTIONS', url: '/api/attempts', headers: { host, origin,
      'access-control-request-method': 'POST', 'access-control-request-headers': 'x-csrf-token' } });
    expect(preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(preflight.headers['access-control-allow-headers']).toBeUndefined();
  });

  it('isolates two configured public owners and ignores all client identity hints', async () => {
    const first = await setup(), second = await setup();
    const forged = { ...first.headers, authorization: 'Bearer forged', 'x-owner-id': second.owner,
      'x-public-owner-id': second.owner, 'x-session-id': 'attacker-session', cookie: `owner_id=${second.owner}` };
    const response = await first.app.inject({ method: 'POST', url: '/api/attempts', headers: forged, payload: body });
    expect(response.statusCode).toBe(200);
    expect(response.json().attempt.sessionId).toBe('hosted-2026-01-01');
    expect((await first.app.inject({ url: '/api/state', headers: forged })).json().attempts).toHaveLength(1);
    expect((await second.app.inject({ url: '/api/state', headers: second.headers })).json().attempts).toEqual([]);
    expect((await harness.database.query('SELECT DISTINCT owner_id FROM sei.attempts WHERE id=$1', [response.json().attempt.id])).rows).toEqual([{ owner_id: first.owner }]);
    await first.app.inject({ method: 'PUT', url: '/api/drafts/synthetic.mc', headers: first.headers, payload: { taskVersion: 1, answer: 'private to first configured owner' } });
    expect((await second.app.inject({ url: '/api/drafts/synthetic.mc', headers: second.headers })).json().answer).toBe(null);
    for (const sql of ['SELECT * FROM public.answers', 'SELECT * FROM lesson_planning.lessons']) {
      await expect(harness.pool.query(sql)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(withOwnerTransaction(harness.pool, { sub: second.owner, role: 'authenticated' }, client => client.query(
      'INSERT INTO sei.task_versions(owner_id,id,version,entity_json) VALUES($1,$2,$3,$4::jsonb)',
      [first.owner, 'forged', '1', JSON.stringify({ id: 'forged', version: 1 })],
    ))).rejects.toMatchObject({ code: '42501' });
  });

  it('enforces append-only grants and triggers on study history and owner RLS on every new table', async () => {
    const { owner, content } = await setup();
    await run(owner, content, store => store.submit(body, 'synthetic'));
    const immutable = ['task_versions', 'attempts', 'judgments', 'evidence_events'];
    for (const table of [...immutable, 'drafts']) {
      expect((await harness.database.query('SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid=$1::regclass', [`sei.${table}`])).rows[0])
        .toEqual({ relrowsecurity: true, relforcerowsecurity: true });
      expect((await harness.pool.query(`SELECT * FROM sei.${table}`)).rows).toEqual([]);
    }
    for (const table of immutable) {
      const before = (await harness.database.query(`SELECT * FROM sei.${table} WHERE owner_id=$1 ORDER BY sequence`, [owner])).rows;
      for (const statement of [`UPDATE sei.${table} SET owner_id=owner_id`, `DELETE FROM sei.${table}`, `TRUNCATE sei.${table} CASCADE`]) {
        await expect(withOwnerTransaction(harness.pool, { sub: owner, role: 'authenticated' }, client => client.query(statement)))
          .rejects.toMatchObject({ code: '42501' });
        await expect(harness.database.query(statement)).rejects.toThrow(/append.only/i);
      }
      expect((await harness.database.query(`SELECT * FROM sei.${table} WHERE owner_id=$1 ORDER BY sequence`, [owner])).rows).toEqual(before);
    }
    await expect(withOwnerTransaction(harness.pool, { sub: owner, role: 'authenticated' }, client => client.query('DELETE FROM sei.drafts')))
      .rejects.toMatchObject({ code: '42501' });
  });

  it('serializes concurrent submissions and rolls back the complete attempt/judgment/evidence operation', async () => {
    const { owner, content } = await setup();
    const results = await Promise.all([run(owner, content, store => store.submit(body, 'one')),
      run(owner, content, store => store.submit(body, 'two'))]);
    expect(results.filter(result => result.evidenceEvents[0].eligible)).toHaveLength(1);
    expect(results.map(result => result.evidenceEvents[0].eligibilityContextAttemptIds!.length).sort()).toEqual([0, 1]);
    const before = await run(owner, content, store => store.state());
    await expect(withOwnerTransaction(harness.pool, { sub: owner, role: 'authenticated' }, async client => {
      await new PostgresStudyStore(client, owner, content).submit(body, 'rolled-back');
      throw new Error('Synthetic rollback after study write');
    })).rejects.toThrow('Synthetic rollback');
    expect(await run(owner, content, store => store.state())).toEqual(before);
    const conflict = structuredClone(content);
    conflict.tasks[0].prompt = 'Conflicting same-version content';
    await expect(run(owner, conflict, store => store.seedCatalog())).rejects.toThrow('Immutable catalog conflict');
    expect(await run(owner, content, store => store.state())).toEqual(before);
  });
});
