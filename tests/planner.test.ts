import {describe, expect, it} from 'vitest';
import type {Catalog} from '../packages/shared/src/index.js';
import {planSession, type PlannerState, type PlannerTrack} from '../packages/shared/src/planner.js';

const source = {id: 'source.synthetic.v1', version: 1, url: 'https://example.org/synthetic', title: 'Synthetic source', retrievedAt: '2026-01-01T00:00:00Z', sha256: 'synthetic', excerpt: 'Synthetic only', reviewState: 'source_compared' as const};
const task = (id: string, family = id, kind: 'mc' | 'short' | 'case' | 'writing' = 'short'): Catalog['tasks'][number] => ({
  id, version: 1, title: id, kind, prompt: 'Synthetic practice only', skillIds: ['skill'], familyId: family,
  reviewState: 'source_checked', sourceRefs: [source.id], noveltyKind: kind === 'case' ? 'unfamiliar' : 'familiar',
  ...(['mc', 'short'].includes(kind) ? {answerKey: {accepted: ['synthetic'], feedback: 'Synthetic', wrongFeedback: {}}} : {}),
});
const catalog: Catalog = {
  schemaVersion: 1, sources: [source], objectives: [{id: 'objective', version: 1, sourceVersionId: source.id, text: 'Synthetic objective'}],
  statements: [{id: 'statement', version: 1, objectiveId: 'objective', sourceVersionId: source.id, text: 'Synthetic statement'}],
  skills: [{id: 'skill', version: 1, title: 'Synthetic skill', status: 'source_checked'}], competencies: [], indicators: [],
  alignments: [{id: 'alignment', skillId: 'skill', statementId: 'statement', frameworkKind: 'synthetic', rationale: 'Broad mapping only', sourceVersionId: source.id}],
  prerequisites: [], lessons: [], cards: [], mentorTexts: [], rubrics: [], reviewEvents: [],
  tasks: [task('a'), task('b'), task('case', 'case', 'case'), task('writing', 'writing', 'writing')],
};
const empty = (): PlannerState => ({attempts: [], judgments: [], evidenceEvents: [], drafts: []});
const at = (day: number, hour = 12) => `2026-01-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const observation = (id: string, taskId: string, day: number, extra: Record<string, unknown> = {}) => ({id, taskId, taskVersion: 1, exposureGroupId: taskId, startedAt: at(day), submittedAt: at(day), hintCount: 0, assistance: [], parentAttemptId: null, ...extra});
function judged(attempts: PlannerState['attempts'], failures: string[] = []): PlannerState {
  return {attempts, judgments: attempts.map(a => ({id: `j-${a.id}`, attemptId: a.id, createdAt: a.submittedAt, result: {status: failures.includes(String(a.id)) ? 'incorrect' : 'correct', sourceChecked: true, provisional: false}})), evidenceEvents: attempts.map(a => ({id: `e-${a.id}`, attemptId: a.id, judgmentId: `j-${a.id}`, skillId: 'skill', eligible: true})), drafts: []};
}
const recommend = (state: PlannerState, now = at(5), current = catalog, track: PlannerTrack = 'RETRIEVAL') => planSession({catalog: current, state, now}).recommendations.find(r => r.track === track)!;

describe('deterministic read-only session planning', () => {
  it('keeps retrieval, application/transfer and writing distinct with explicit evidence limits', () => {
    const plan = planSession({catalog, state: empty(), now: at(5)});
    expect(plan.recommendations.map(r => r.track)).toEqual(['RETRIEVAL', 'APPLICATION_TRANSFER', 'WRITING']);
    expect(plan.recommendations.map(r => r.taskId)).toEqual(['a', 'case', 'writing']);
    expect(plan.recommendations.map(r => r.independence)).toEqual(['potentially_independent', 'pending_review', 'pending_review']);
    expect(plan.recommendations[0].reasons.join(' ')).toContain('not human validated');
    expect(plan.recommendations[0].reasons.join(' ')).toContain('no current explicit statement-level practice binding');
    expect(plan.gaps.map(g => g.statementId)).toContain('statement');
  });

  it('is identical under reordered catalog arrays and merged event inputs, with an injected clock', () => {
    const attempts = [observation('one', 'a', 1), observation('two', 'b', 2), observation('failure', 'a', 3)];
    const state = judged(attempts, ['failure']);
    const first = planSession({catalog, state, now: at(5)});
    const reordered = {...catalog, tasks: [...catalog.tasks].reverse(), skills: [...catalog.skills].reverse(), sources: [...catalog.sources].reverse(), statements: [...catalog.statements].reverse(), alignments: [...catalog.alignments].reverse()};
    expect(planSession({catalog: reordered, state: {...state, attempts: [...state.attempts].reverse(), judgments: [...state.judgments].reverse(), evidenceEvents: [...state.evidenceEvents].reverse()}, now: Date.parse(at(5))})).toEqual(first);
  });

  it('does not mutate attempts, judgments, evidence or drafts when recommendations are selected or overridden', () => {
    const state = judged([observation('one', 'a', 1)]);
    const before = structuredClone({catalog, state});
    const freeze = (value: unknown) => { if (value && typeof value === 'object') { Object.freeze(value); for (const nested of Object.values(value)) freeze(nested); } };
    freeze(state); freeze(catalog);
    const plan = planSession({catalog, state, now: at(5)});
    const override = catalog.tasks.find(t => t.id !== plan.recommendations[0].taskId);
    expect(override).toBeDefined();
    expect({catalog, state}).toEqual(before);
    expect(state.attempts).toHaveLength(1);
  });

  it('rejects invalid clocks instead of silently using wall-clock time', () => {
    for (const now of ['not a date', NaN, Infinity, 9e99]) expect(() => planSession({catalog, state: empty(), now})).toThrow('injected planning time');
  });
});

describe('feedback, draft and version boundaries', () => {
  it('does not recommend an immediate correction or same-family paraphrase as independent', () => {
    const current = {...catalog, tasks: [task('a'), task('paraphrase', 'a')]};
    const state = judged([observation('wrong', 'a', 1)], ['wrong']);
    const rec = recommend(state, at(1, 13), current);
    expect(rec).toMatchObject({kind: 'gap', independence: 'unavailable', availableAt: at(2)});
    expect(rec.reasons.join(' ')).toContain('Same-family feedback');
  });

  it('uses the latest family response and only offers a fresh retest at the exact qualifying boundary', () => {
    const current = {...catalog, tasks: [task('a')]};
    const state = judged([observation('one', 'a', 1), observation('correction', 'a', 1, {startedAt: at(1, 13), submittedAt: at(1, 13), parentAttemptId: 'one'})]);
    expect(recommend(state, at(2), current).kind).toBe('gap');
    expect(recommend(state, at(2, 13), current)).toMatchObject({kind: 'task', startMode: 'fresh', independence: 'potentially_independent', availableAt: at(2, 13)});
  });

  it('prioritizes genuinely available delayed fresh work over held drafts', () => {
    const state = judged([observation('helped', 'a', 1, {hintCount: 1}), observation('other', 'b', 1)]);
    state.drafts = [{taskId: 'a', taskVersion: 1, answer: {response: 'held', startedAt: at(1, 13), hintCount: 1, assistance: [], parentAttemptId: 'helped'}}];
    expect(recommend(state, at(3))).toMatchObject({taskId: 'b', startMode: 'fresh', independence: 'potentially_independent'});
    const held = recommend(state, at(3), {...catalog, tasks: [task('a')]});
    expect(held).toMatchObject({taskId: 'a', startMode: 'resume', independence: 'assisted'});
    expect(held.reasons.join(' ')).toContain('waiting does not make it independent');
  });

  it('keeps an unhinted draft that began during cooldown assisted after time passes', () => {
    const state = judged([observation('one', 'a', 1)]);
    state.drafts = [{taskId: 'a', taskVersion: 1, answer: {response: 'held', startedAt: at(1, 13), hintCount: 0, assistance: []}}];
    expect(recommend(state, at(4), {...catalog, tasks: [task('a')]}).independence).toBe('assisted');
  });

  it('prefers an untouched family over repeating an already successful family', () => {
    const state = judged([observation('success', 'a', 1)]);
    expect(recommend(state, at(5))).toMatchObject({taskId: 'b', startMode: 'fresh', independence: 'potentially_independent'});
    expect(recommend(state, at(5)).reasons.join(' ')).toContain('without repeating an already successful family');
  });

  it('prioritizes a delayed fresh recheck after failure or prior assistance', () => {
    const failed = judged([observation('failure', 'a', 1)], ['failure']);
    expect(recommend(failed, at(3)).taskId).toBe('a');
    const helped = judged([observation('helped', 'a', 1, {hintCount: 1})]);
    expect(recommend(helped, at(3))).toMatchObject({taskId: 'a', independence: 'potentially_independent', startMode: 'fresh'});
  });

  it('does not call a draft with a missing revision parent independent', () => {
    const state = empty();
    state.drafts = [{taskId: 'a', taskVersion: 1, answer: {response: 'synthetic', hintCount: 0, assistance: [], startedAt: at(3), parentAttemptId: 'missing'}}];
    const rec = recommend(state, at(4), {...catalog, tasks: [task('a')]});
    expect(rec.independence).toBe('assisted');
    expect(rec.reasons.join(' ')).toContain('missing revision parent');
  });

  it('does not assume that a hinted draft with no submissions is independent', () => {
    const state = empty();
    state.drafts = [{taskId: 'a', taskVersion: 1, answer: {response: 'synthetic', hintCount: 1, assistance: [], startedAt: at(1)}}];
    expect(recommend(state, at(4), {...catalog, tasks: [task('a')]})).toMatchObject({startMode: 'resume', independence: 'assisted'});
  });

  it('keeps archived attempts in cooldown, and archived drafts separate from the new version', () => {
    const current = {...catalog, tasks: [{...task('a'), version: 2, familyId: 'changed-family'}]};
    const state = judged([observation('old', 'a', 1)]);
    state.taskVersions = [task('a')];
    state.drafts = [{taskId: 'a', taskVersion: 1, answer: {response: 'old wording', startedAt: at(1)}}];
    expect(recommend(state, at(1, 13), current).kind).toBe('gap');
    const later = recommend(state, at(2), current);
    expect(later).toMatchObject({taskVersion: 2, startMode: 'fresh'});
    expect(later.reasons.join(' ')).toContain('archived-version draft');
    expect(later.reasons.join(' ')).toContain('version change does not reset');
  });
});

describe('uncertainty is not recovery', () => {
  it('retains the latest failure recheck despite a feedback-trained correction', () => {
    const state = judged([observation('one', 'a', 1), observation('two', 'b', 2), observation('failure', 'a', 3), observation('correction', 'a', 3, {submittedAt: at(3, 13), startedAt: at(3, 13), parentAttemptId: 'failure'})], ['failure']);
    expect(recommend(state).reasons.join(' ')).toContain('Needs recheck');
    expect(recommend(state).reasons.join(' ')).toContain('latest independent observation was a failure');
  });

  it('retains merged-history failure uncertainty even when the recorded failure loses eligibility', () => {
    const state = judged([observation('one', 'a', 1), observation('two', 'b', 2), observation('failure', 'a', 3), observation('imported', 'a', 2, {submittedAt: at(2, 13), startedAt: at(2, 13)})], ['failure']);
    const rec = recommend(state);
    expect(rec.reasons.join(' ')).toContain('Needs recheck');
    expect(rec.reasons.join(' ')).toContain('merged feedback history');
  });

  it('leaves pending and provisionally judged writing pending instead of scheduling a corrective loop', () => {
    const state = empty();
    state.attempts = [observation('essay', 'writing', 1)];
    state.judgments = [{id: 'provisional', attemptId: 'essay', createdAt: at(2), result: {status: 'correct', sourceChecked: true, provisional: true}}];
    const rec = recommend(state, at(5), catalog, 'WRITING');
    expect(rec).toMatchObject({kind: 'gap', independence: 'unavailable'});
    expect(rec.reasons.join(' ')).toContain('Provisional feedback remains pending');
    const immediate = recommend(state, at(1, 13), catalog, 'WRITING');
    expect(immediate.reasons.join(' ')).toContain('Provisional feedback remains pending');
    expect(immediate.reasons.join(' ')).toContain('Same-family feedback');
  });

  it('flags a missing archived source version as a recheck even when the current task has a source', () => {
    const state = judged([observation('old', 'a', 1)]);
    state.taskVersions = [{...task('a'), sourceRefs: ['missing-source']}];
    const current = {...catalog, tasks: [{...task('a'), version: 2}]};
    expect(recommend(state, at(5), current).reasons.join(' ')).toContain('historical task references missing');
  });

  it('does not recommend draft/retired tasks or missing/superseded sources', () => {
    for (const reviewState of ['draft', 'retired'] as const) expect(recommend(empty(), at(5), {...catalog, tasks: [{...task('a'), reviewState}]}).kind).toBe('gap');
    for (const sources of [[], [{...source, reviewState: 'superseded' as const}], [{...source, reviewState: 'unverified' as const}]]) {
      expect(recommend(empty(), at(5), {...catalog, tasks: [task('a')], sources}).kind).toBe('gap');
    }
  });

  it('does not infer independence when an archived attempt has neither a snapshot nor a known family', () => {
    const state = judged([observation('missing', 'missing-task', 1, {exposureGroupId: undefined})]);
    const rec = recommend(state);
    expect(rec.kind).toBe('gap');
    expect(rec.reasons.join(' ')).toContain('Missing task-family snapshots');
  });

  it('returns truthful research recommendations for an empty curriculum', () => {
    const plan = planSession({catalog: {...catalog, tasks: []}, state: empty(), now: at(5)});
    expect(plan.recommendations).toHaveLength(3);
    expect(plan.recommendations.every(r => r.kind === 'gap' && r.taskId === undefined)).toBe(true);
    expect(plan.gaps).toHaveLength(1);
  });
});
