import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {Catalog} from '../packages/shared/src/index.js';
import {deriveCoverage, type CoverageState} from '../packages/shared/src/coverage.js';
import {INTEGRATION_REFERRAL_ID, SOURCE_COVERAGE_CONTRACT} from '../packages/shared/src/coverage-contract.js';
import {readSliceBaseline} from './obj0002-0003-baseline';
import {COVERAGE_CONTRACT_VERSION as BASE_CONTRACT_VERSION, SOURCE_COVERAGE_CONTRACT as BASE_CONTRACT} from './fixtures/coverage-contract-d8e0dd883457cc01fd6a394e3d5c4fc35993f506';

const catalog = JSON.parse(readFileSync('content/catalog.json', 'utf8')) as Catalog;
const inventory = JSON.parse(readFileSync('content/inventory.json', 'utf8')) as Catalog;
const baseline = readSliceBaseline();
const sharedStatement = 'mtel56.obj.0001.ds.01';
const observation = (id: string, taskId: string, submittedAt: string, extra: Record<string, unknown> = {}) =>
  ({id, taskId, taskVersion: 1, startedAt: submittedAt, submittedAt, hintCount: 0, assistance: [], ...extra});
const judgment = (attemptId: string, status = 'correct', extra: Record<string, unknown> = {}) =>
  ({id: `judgment-${attemptId}`, attemptId, result: {status, sourceChecked: true, provisional: false}, ...extra});
const event = (attemptId: string, skillId = 'sei.skill.shared-responsibility') =>
  ({id: `event-${attemptId}`, attemptId, judgmentId: `judgment-${attemptId}`, skillId, eligible: true});
const history = (attempts: CoverageState['attempts'], incorrect: string[] = []): CoverageState =>
  ({attempts, judgments: attempts.map(a => judgment(a.id, incorrect.includes(a.id) ? 'incorrect' : 'correct')), evidenceEvents: attempts.map(a => event(a.id))});
const row = (state: CoverageState, id = sharedStatement, c = catalog) => deriveCoverage(c, state).statements.find(s => s.statementId === id)!;
const empty: CoverageState = {attempts: [], judgments: [], evidenceEvents: []};

describe('source-backed statement coverage contract', () => {
  it('preserves the exact inventory and separate 59-bullet/one-referral denominators', () => {
    expect(catalog.objectives).toEqual(inventory.objectives);
    expect(catalog.statements).toEqual(inventory.statements);
    // Preserve every v2 inventory/coverage count on its exact portable catalog.
    const report = deriveCoverage(baseline);
    expect(BASE_CONTRACT_VERSION).toBe(2);
    expect(report.contractVersion).toBe(3);
    expect(report.totals).toMatchObject({objectiveCount: 13, statementCount: 60, bulletCount: 59, referralCount: 1, mappedStatementCount: 9, partialInstructionCount: 8, reviewedPracticeCount: 9, gapCount: 60, sourceCheckedTaskCount: 37, humanReviewedTaskCount: 0});
    expect(report.objectives.find(o => o.objectiveId === 'mtel56.obj.0013')).toMatchObject({statementCount: 1, bulletCount: 0, referralCount: 1, complete: false});
    expect(report.statements.find(s => s.statementId === INTEGRATION_REFERRAL_ID)?.kind).toBe('integration_referral');
    expect(catalog.competencies).toHaveLength(11);
    expect(catalog.indicators).toHaveLength(5);
    expect(catalog.alignments).toHaveLength(23);
  });

  it('keeps all 13 objective gaps explicit and empty objectives incomplete', () => {
    const report = deriveCoverage(catalog);
    expect(report.objectives.every(o => !o.complete && o.gaps.length > 0 && o.gapCount > 0)).toBe(true);
    const missing = deriveCoverage({...catalog, statements: []});
    expect(missing.objectives).toHaveLength(13);
    expect(missing.objectives.every(o => !o.complete && o.statementCount === 0 && o.gaps[0].includes('never complete'))).toBe(true);
  });

  it('binds only inspected scopes and keeps unreviewed legal specifics as gaps', () => {
    expect(BASE_CONTRACT).toHaveLength(11);
    expect(SOURCE_COVERAGE_CONTRACT.slice(0, BASE_CONTRACT.length)).toEqual(BASE_CONTRACT);
    const policy = row(empty, 'mtel56.obj.0001.ds.03');
    expect(policy.gaps.join(' ')).toContain('exit thresholds');
    expect(policy.gaps.join(' ')).not.toContain('monitoring durations');
    expect(policy.gaps.join(' ')).toContain('reclassification');
    expect(policy.partialInstruction.map(l => l.lessonId)).toContain('lesson.obj0001.identification-shared.v1');
    expect(policy.partialInstruction.map(l => l.lessonId)).not.toContain('lesson.current-former');
    expect(row(empty, 'mtel56.obj.0001.ds.02').reviewedPractice).toEqual([]);
    expect(row(empty, 'mtel56.obj.0009.ds.04').gaps.join(' ')).toContain('ACCESS/MCAS');
    expect(row(empty, INTEGRATION_REFERRAL_ID).gaps.join(' ')).toContain('official Parts II–V');
  });

  it('adds reviewed partial Objective 0001 practice without claiming legal or objective completion', () => {
    const report = deriveCoverage(catalog);
    const policy = row(empty, 'mtel56.obj.0001.ds.03');
    const shared = row(empty);
    expect(shared.reviewedPractice.map(t => t.taskId)).toContain('task.obj0001.shared-services');
    expect(shared.reviewedPractice.map(t => t.taskId)).toContain('task.obj0001.community-archive-case');
    expect(shared.reviewedPractice.find(t => t.taskId === 'task.shared-plan')?.scope).toBe('Shared classroom responsibility and communicating content/language observations to colleagues.');
    expect(policy.reviewedPractice.find(t => t.taskId === 'task.survey-purpose')?.scope).toBe('Survey versus proficiency, family communication preferences, and evidence-responsive support for current/former ELs; recognizing the need to verify policy.');
    expect(shared.reviewedPractice.find(t => t.taskId === 'task.obj0001.shared-services')?.scope).toContain('preserving ESL instruction');
    expect(policy.reviewedPractice.find(t => t.taskId === 'task.obj0001.fel-support')?.scope).toContain('January 2026 guidance four-year FEL monitoring');
    for (const suffix of ['evidence-chain', 'family-access', 'notice-record', 'opt-out', 'fel-support', 'language-disability', 'community-archive-case']) {
      expect(policy.reviewedPractice.map(t => t.taskId)).toContain(`task.obj0001.${suffix}`);
    }
    expect(report.objectives.find(o => o.objectiveId === 'mtel56.obj.0001')).toMatchObject({partialInstructionCount: 2, reviewedPracticeCount: 2, independentEvidenceCount: 0, complete: false});
    expect(row(empty, 'mtel56.obj.0001.ds.02')).toMatchObject({partialInstruction: [], reviewedPractice: [], complete: false});
  });

  it('never turns a broad skill alignment into statement instruction or evidence', () => {
    const target = 'mtel56.obj.0002.ds.01';
    const c = structuredClone(baseline);
    c.alignments.push({id: 'synthetic-broad-alignment', skillId: 'sei.skill.shared-responsibility', statementId: target, frameworkKind: 'mtel56', rationale: 'Synthetic broad alignment', sourceVersionId: c.statements[0].sourceVersionId});
    const state = history([observation('one', 'task.shared-plan', '2026-11-01T12:00:00Z'), observation('two', 'task.team-evidence', '2026-11-03T12:00:00Z')]);
    const unrelated = row(state, target, c);
    expect(unrelated.mappedSkillIds).toContain('sei.skill.shared-responsibility');
    expect(unrelated.partialInstruction).toEqual([]);
    expect(unrelated.reviewedPractice).toEqual([]);
    expect(unrelated.independentEvidence).toEqual([]);
    expect(unrelated.complete).toBe(false);
    expect(row(state).independentEvidence).toHaveLength(2);
  });

  it('counts only scoped independent observations, never full statement completion', () => {
    const state = history([observation('one', 'task.shared-plan', '2026-11-01T12:00:00Z'), observation('two', 'task.team-evidence', '2026-11-03T12:00:00Z')]);
    expect(row(state)).toMatchObject({complete: false, needsRecheck: false});
    expect(row(state).independentEvidence).toHaveLength(2);
    expect(row(state).gaps.length).toBeGreaterThan(0);
    expect(deriveCoverage(catalog, state).totals.independentEvidenceCount).toBe(1);
  });

  it('excludes immediate corrections and same-family paraphrases', () => {
    const state = history([
      observation('failed', 'task.shared-plan', '2026-11-01T12:00:00Z'),
      observation('paraphrase', 'task.shared-recall', '2026-11-01T13:00:00Z'),
      observation('correction', 'task.shared-plan', '2026-11-01T14:00:00Z', {parentAttemptId: 'failed'}),
    ], ['failed']);
    expect(row(state).independentEvidence).toEqual([]);
    expect(row(state).needsRecheck).toBe(true);
    expect(row(state).exclusions.map(x => x.reason).join(' ')).toContain('24 hours');
  });

  it('checks the start time, preserving held-draft and hint exclusions', () => {
    const state = history([
      observation('first', 'task.shared-plan', '2026-11-01T12:00:00Z'),
      observation('held', 'task.shared-plan', '2026-11-04T12:00:00Z', {startedAt: '2026-11-01T13:00:00Z', parentAttemptId: 'first'}),
      observation('hinted', 'task.team-evidence', '2026-11-05T12:00:00Z', {hintCount: 1}),
    ]);
    expect(row(state).independentEvidence.map(x => x.attemptId)).toEqual(['first']);
    expect(row(state).exclusions.map(x => x.attemptId)).toEqual(['held', 'hinted']);
  });

  it('retains latest failures and merged-history uncertainty until later independent work', () => {
    const state = history([
      observation('one', 'task.shared-plan', '2026-11-01T12:00:00Z'),
      observation('two', 'task.team-evidence', '2026-11-03T12:00:00Z'),
      observation('merged', 'task.shared-recall', '2026-11-04T00:00:00Z'),
      observation('failed', 'task.shared-plan', '2026-11-04T12:00:00Z'),
    ], ['failed']);
    expect(row(state).needsRecheck).toBe(true);
    expect(row(state).exclusions.find(x => x.attemptId === 'failed')?.reason).toContain('Feedback-dependent');
    const recovered = history([...state.attempts, observation('later', 'task.shared-plan', '2026-11-06T12:00:00Z')], ['failed']);
    expect(row(recovered).needsRecheck).toBe(false);
  });

  it('leaves writing pending and does not project its broad skill links onto statements', () => {
    const a = observation('writing', 'task.writing.mentor.math-plans', '2026-11-01T12:00:00Z');
    const state: CoverageState = {attempts: [a], judgments: [{id: 'proposal', attemptId: a.id, result: {status: 'correct', sourceChecked: true, provisional: true}}], evidenceEvents: [event(a.id, 'sei.skill.integrated-writing')]};
    expect(row(state, INTEGRATION_REFERRAL_ID).pendingJudgments).toEqual(['writing']);
    expect(row(state, INTEGRATION_REFERRAL_ID).independentEvidence).toEqual([]);
    expect(row(state, 'mtel56.obj.0008.ds.01').pendingJudgments).toEqual([]);
  });

  it('does not let provisional proposals conceal an authoritative failure', () => {
    const state = history([observation('failed', 'task.shared-plan', '2026-11-01T12:00:00Z')], ['failed']);
    state.judgments = [...state.judgments, {id: 'proposal', attemptId: 'failed', supersedesId: 'judgment-failed', result: {status: 'correct', sourceChecked: true, provisional: true}}];
    expect(row(state).needsRecheck).toBe(true);
    expect(row(state).independentEvidence).toEqual([]);
  });

  it('keeps simultaneous conflicting authoritative judgments conservative in either input order', () => {
    const attempt = observation('conflict', 'task.shared-plan', '2026-11-01T12:00:00Z');
    const judgments = [judgment('conflict', 'incorrect', {id: 'a-failure'}), judgment('conflict', 'correct', {id: 'z-success'})];
    const evidenceEvents = judgments.map(j => ({...event(attempt.id), id: `event-${j.id}`, judgmentId: j.id}));
    for (const ordered of [judgments, [...judgments].reverse()]) {
      const result = row({attempts: [attempt], judgments: ordered, evidenceEvents});
      expect(result.needsRecheck).toBe(true);
      expect(result.independentEvidence).toEqual([]);
    }
  });

  it('keeps archived version history without inheriting a current-version coverage claim', () => {
    const c = structuredClone(catalog), original = c.tasks.find(t => t.id === 'task.shared-plan')!;
    original.version = 2;
    const state = {...history([observation('old', 'task.shared-plan', '2026-11-01T12:00:00Z')]), taskVersions: catalog.tasks};
    const result = row(state, sharedStatement, c);
    expect(result.independentEvidence).toEqual([]);
    expect(result.historicalObservations).toEqual(['old']);
    expect(result.reviewedPractice.some(t => t.taskId === original.id)).toBe(false);
    expect(result.needsRecheck).toBe(true);
  });

  it('invalidates missing/retired source support and changed unversioned lessons', () => {
    const c = structuredClone(catalog);
    c.sources.find(s => s.id === 'source.framework.2026-11-08')!.reviewState = 'superseded';
    const state = history([observation('old', 'task.shared-plan', '2026-11-01T12:00:00Z')]);
    expect(row(state, sharedStatement, c)).toMatchObject({partialInstruction: [], reviewedPractice: [], independentEvidence: [], needsRecheck: true});
    const changed = structuredClone(catalog);
    changed.lessons.find(l => l.id === 'lesson.shared')!.body = 'Synthetic replacement body';
    expect(row(empty, sharedStatement, changed).partialInstruction.map(l => l.lessonId)).toEqual(['lesson.obj0001.identification-shared.v1']);
    changed.lessons.find(l => l.id === 'lesson.obj0001.identification-shared.v1')!.body = 'Synthetic replacement module';
    expect(row(empty, sharedStatement, changed).partialInstruction).toEqual([]);
    const missing = {...catalog, sources: []};
    expect(deriveCoverage(missing).totals.reviewedPracticeCount).toBe(0);
  });

  it('requires fresh binding review when statement/source identities change', () => {
    const c = structuredClone(catalog);
    c.statements.find(s => s.id === sharedStatement)!.version = 2;
    expect(row(empty, sharedStatement, c).reviewedPractice).toEqual([]);
    const changedSource = structuredClone(catalog);
    changedSource.sources.find(s => s.id === 'source.framework.2026-11-08')!.version = 'synthetic-next-version';
    expect(row(empty, sharedStatement, changedSource).reviewedPractice).toEqual([]);
  });

  it('is deterministic under reordering and does not mutate catalog/history', () => {
    const state = history([observation('one', 'task.shared-plan', '2026-11-01T12:00:00Z'), observation('two', 'task.team-evidence', '2026-11-03T12:00:00Z')]);
    const before = JSON.stringify({catalog, state});
    const expected = deriveCoverage(catalog, state);
    const reordered = {...catalog, objectives: [...catalog.objectives].reverse(), statements: [...catalog.statements].reverse(), alignments: [...catalog.alignments].reverse(), tasks: [...catalog.tasks].reverse().map(t => ({...t, sourceRefs: [...t.sourceRefs].reverse(), skillIds: [...t.skillIds].reverse()})), sources: [...catalog.sources].reverse(), lessons: [...catalog.lessons].reverse().map(l => ({...l, sourceRefs: [...l.sourceRefs].reverse(), skillIds: [...l.skillIds].reverse()}))};
    expect(deriveCoverage(reordered, {attempts: [...state.attempts].reverse(), judgments: [...state.judgments].reverse(), evidenceEvents: [...state.evidenceEvents].reverse()})).toEqual(expected);
    expect(JSON.stringify({catalog, state})).toBe(before);
  });
});
