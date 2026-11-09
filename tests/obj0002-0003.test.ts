import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {getAttemptEligibility, getReadiness, type Catalog, validateCatalog} from '../packages/shared/src/index.js';
import {deriveCoverage, lessonFingerprint} from '../packages/shared/src/coverage.js';
import {COVERAGE_CONTRACT_VERSION, SOURCE_COVERAGE_CONTRACT} from '../packages/shared/src/coverage-contract.js';
import {planSession, type PlannerState} from '../packages/shared/src/planner.js';
import {SeiStore} from '../apps/server/src/store.js';
import {parseSliceBaseline, readSliceBaseline, verifySliceContractFixture} from './obj0002-0003-baseline';
import {SOURCE_COVERAGE_CONTRACT as baseContract} from './fixtures/coverage-contract-d8e0dd883457cc01fd6a394e3d5c4fc35993f506';

const read = (name: string) => JSON.parse(readFileSync(name, 'utf8'));
const catalog = read('content/catalog.json') as Catalog;
const baseline = readSliceBaseline();
const module = read('content/obj0002-0003-module.json') as Pick<Catalog, 'lessons' | 'tasks'>;
const sources = (read('content/obj0002-0003-sources.json') as Pick<Catalog, 'sources'>).sources;
const reviews = (read('content/obj0002-0003-review.json') as Pick<Catalog, 'reviewEvents'>).reviewEvents;
const checks = module.tasks.filter(t => t.kind === 'mc');
const cases = module.tasks.filter(t => t.kind === 'case');
const scopeBindings = SOURCE_COVERAGE_CONTRACT.slice(baseContract.length);
const task = (id: string) => module.tasks.find(t => t.id === id)!;
const empty = (): PlannerState => ({attempts: [], judgments: [], evidenceEvents: [], drafts: []});
const canonical = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
const stores: SeiStore[] = [];
const store = (value = catalog) => {const s = new SeiStore(value, ':memory:'); stores.push(s); return s;};
afterEach(() => stores.splice(0).forEach(s => s.close()));

describe('Objective 0002/0003 exact additive content and bounded review', () => {
  it('loads digest-verified source archive fixtures without Git history and preserves every older entity', () => {
    expect(validateCatalog(catalog)).toEqual([]);
    expect(() => verifySliceContractFixture()).not.toThrow();
    const baselineBytes = readFileSync(new URL('./fixtures/catalog-d8e0dd883457cc01fd6a394e3d5c4fc35993f506.json', import.meta.url));
    expect(() => parseSliceBaseline(Buffer.concat([baselineBytes, Buffer.from('\n')]))).toThrow('integrity');
    expect(() => parseSliceBaseline(Buffer.from(JSON.stringify(baseline)))).toThrow('integrity');
    expect(() => parseSliceBaseline(Buffer.from('{'))).toThrow('integrity');
    for (const [key, rows] of Object.entries(baseline)) {
      const current = catalog[key as keyof Catalog];
      expect(Array.isArray(rows) ? (current as unknown[]).slice(0, rows.length) : current, key).toEqual(rows);
    }
    for (const key of ['objectives', 'statements', 'competencies', 'indicators', 'alignments', 'skills', 'prerequisites', 'mentorTexts', 'rubrics', 'cards'] as const) expect(catalog[key], key).toEqual(baseline[key]);
    expect(catalog.tasks.filter(t => t.kind === 'writing')).toEqual(baseline.tasks.filter(t => t.kind === 'writing'));
    expect(SOURCE_COVERAGE_CONTRACT.slice(0, baseContract.length)).toEqual(baseContract);
    expect(catalog.lessons.slice(baseline.lessons.length)).toEqual(module.lessons);
    expect(catalog.tasks.slice(baseline.tasks.length)).toEqual(module.tasks);
    expect(catalog.sources.slice(baseline.sources.length)).toEqual(sources);
    expect(catalog.reviewEvents.slice(baseline.reviewEvents.length)).toEqual(reviews);
  });

  it('has exactly twelve concept checks and two nuanced cases across two scaffolded lessons', () => {
    expect(module.lessons.map(l => l.id)).toEqual(['lesson.obj0002.diversity.v1', 'lesson.obj0003.culture-partnerships.v1']);
    expect(checks).toHaveLength(12);
    expect(cases).toHaveLength(2);
    expect(new Set(checks.map(t => t.familyId)).size).toBe(11);
    expect(task('task.obj0002.slife-criteria').familyId).toBe(task('task.obj0002.slife-characteristics').familyId);
    expect(cases.map(t => t.id)).toEqual(['task.obj0002.contrasting-schooling-case', 'task.obj0003.partnership-case']);
    for (const lesson of module.lessons) {
      expect(lesson.body).toMatch(/unofficial/i);
      expect(lesson.body).toMatch(/content goal/i);
      expect(lesson.body).toMatch(/language goal/i);
      expect((lesson.body.match(/WORKED EXAMPLE/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect((lesson.body.match(/GUIDED/g) ?? []).length).toBeGreaterThanOrEqual(2);
      expect(lesson.body).toMatch(/assisted/i);
      expect(lesson.body).toMatch(/creates? no attempts? or (?:independent )?(?:evidence|successes)/i);
      expect(lesson.body.length).toBeGreaterThan(4000);
    }
    expect(module.tasks.every(t => t.reviewState === 'source_checked' && module.lessons.some(l => l.id === t.lessonId))).toBe(true);
  });

  it('pins actual separate model review payloads and supplied-packet provenance', () => {
    const entities = [...sources, ...module.lessons, ...module.tasks];
    expect(reviews).toHaveLength(entities.length);
    for (const entity of entities) {
      const review = reviews.find(r => r.entityId === entity.id)!;
      expect(review?.reviewerKind, entity.id).toBe('model');
      expect(review.payloadSha256).toBe(createHash('sha256').update(canonical(entity)).digest('hex'));
      expect(JSON.stringify(review)).toMatch(/supplied.*packet|packet.*supplied/i);
      expect(JSON.stringify(review)).toMatch(/not human review|no human review/i);
    }
    for (const source of sources) {
      expect(source.retrievedAt).toBe('2026-11-08');
      expect(source.retrievalTimezone).toBe('America/New_York');
      expect(source.reviewState).toBe('source_compared');
      expect(source.provenance).toMatch(/Codex did not (?:fetch|retrieve)/);
    }
    expect(catalog.tasks.some(t => t.reviewState === 'human_reviewed')).toBe(false);
  });

  it('grades every finite option with its own source-specific explanation', () => {
    const comparedKeys = {'obj0002.label-overlap': 'c', 'obj0002.slife-criteria': 'b', 'obj0002.slife-characteristics': 'd',
      'obj0002.ltel-access': 'a', 'obj0002.profile-planning': 'c', 'obj0002.privacy-support': 'b', 'obj0002.learning-expectations': 'd',
      'obj0003.culture-inquiry': 'a', 'obj0003.language-resources': 'b', 'obj0003.family-participation': 'd',
      'obj0003.competent-interpretation': 'a', 'obj0003.preference-status': 'c'};
    for (const [suffix, key] of Object.entries(comparedKeys)) expect(task(`task.${suffix}`).answerKey!.accepted).toEqual([key]);
    for (const item of checks) {
      const s = store();
      expect(item.options).toHaveLength(4);
      expect(item.answerKey!.accepted).toHaveLength(1);
      const wrong = item.options!.filter(o => !item.answerKey!.accepted.includes(o.id));
      expect(Object.keys(item.answerKey!.wrongFeedback).sort()).toEqual(wrong.map(o => o.id).sort());
      const rationales = [item.answerKey!.feedback, ...Object.values(item.answerKey!.wrongFeedback)];
      expect(new Set(rationales).size).toBe(4);
      for (const rationale of rationales) {
        expect(rationale.length).toBeGreaterThan(70);
        expect(item.sourceRefs.some(ref => rationale.includes(ref))).toBe(true);
      }
      for (const option of item.options!) {
        const result = s.submit({taskId: item.id, taskVersion: item.version, answer: option.id, hintCount: 0}, 'synthetic-option-check');
        const correct = item.answerKey!.accepted.includes(option.id);
        expect(result.judgment.result).toMatchObject({status: correct ? 'correct' : 'incorrect', provisional: false, sourceChecked: true,
          feedback: correct ? item.answerKey!.feedback : item.answerKey!.wrongFeedback[option.id]});
      }
    }
  });

  it('separates source-specific labels, SLIFE criteria and privacy from stereotyped inferences', () => {
    const diversity = module.lessons[0].body;
    expect(diversity).toMatch(/June 2024/);
    expect(diversity).toMatch(/Exhibit 1/);
    expect(diversity).toMatch(/DOE025/);
    expect(diversity).toMatch(/8 to 21|8–21|8-21/);
    expect(diversity).toMatch(/after grade 2/);
    expect(diversity).toMatch(/6 months/);
    expect(diversity).toMatch(/holistic/i);
    expect(diversity).toMatch(/MAY|may/);
    expect(diversity).toMatch(/June 2023/);
    expect(diversity).toMatch(/February 2, 2026/);
    expect(diversity).toMatch(/ESEA/);
    expect(diversity).toMatch(/SIFE/);
    expect(diversity).toMatch(/overlap/i);
    const culture = module.lessons[1].body;
    expect(culture).toMatch(/August 2018/);
    expect(culture).toMatch(/competent/i);
    expect(culture).toMatch(/PTA/);
    expect(task('task.obj0002.privacy-support').answerKey!.feedback).toMatch(/privacy|sensitive|recount/i);
    expect(task('task.obj0003.preference-status').answerKey!.feedback).toMatch(/informational, not child identification evidence/i);
    for (const item of cases) {
      expect(item.answerKey).toBeUndefined();
      expect(item.prompt).toMatch(/uncertain|uncertainty/i);
      expect(item.prompt).toMatch(/justif/i);
      expect(item.prompt).toMatch(/pending|provisional/i);
      expect(item.prompt).toMatch(/keyword/i);
      expect(item.prompt).toMatch(/synthetic/i);
      expect(item.prompt).toMatch(/do not infer|cannot infer|never infer|must not infer/i);
    }
    expect(cases[0].prompt).toMatch(/theater sound investigation/);
    expect(cases[0].prompt).toMatch(/fair follow-up observation/);
    expect(cases[1].prompt).toMatch(/media club/);
    expect(cases[1].prompt).toMatch(/Compare the two launch plans/);
    expect(JSON.stringify(module)).not.toMatch(/(?:within|no later than)\s+(?:10|20|30|ten|twenty|thirty)\s+(?:school\s+)?days/i);
  });

  it('binds the exact original eight statements with narrow task scopes and no objective completion', () => {
    expect(COVERAGE_CONTRACT_VERSION).toBe(3);
    expect(scopeBindings).toHaveLength(14);
    const official = baseline.statements.filter(s => /^mtel56\.obj\.000[23]\./.test(s.id));
    expect(official).toHaveLength(8);
    expect([...new Set(scopeBindings.map(b => b.statementId))].sort()).toEqual(official.map(s => s.id).sort());
    const expectedScopes: Record<string, string[]> = {
      '0002.ds.01': ['obj0002.label-overlap', 'obj0002.slife-criteria', 'obj0002.slife-characteristics', 'obj0002.ltel-access'],
      '0002.ds.02': ['obj0002.profile-planning', 'obj0002.contrasting-schooling-case'],
      '0002.ds.03': ['obj0002.privacy-support'],
      '0002.ds.04': ['obj0002.learning-expectations'],
      '0003.ds.01': ['obj0003.culture-inquiry'],
      '0003.ds.02': ['obj0003.language-resources'],
      '0003.ds.03': ['obj0003.family-participation'],
      '0003.ds.04': ['obj0003.competent-interpretation', 'obj0003.preference-status', 'obj0003.partnership-case'],
    };
    for (const [suffix, ids] of Object.entries(expectedScopes)) {
      expect(scopeBindings.filter(b => b.statementId === `mtel56.obj.${suffix}`).flatMap(b => b.tasks.map(t => t.taskId)).sort()).toEqual(ids.map(id => `task.${id}`).sort());
    }
    for (const binding of scopeBindings) {
      const statement = official.find(s => s.id === binding.statementId)!;
      expect(binding).toMatchObject({statementVersion: statement.version, sourceVersionId: statement.sourceVersionId});
      expect(binding.scope.length).toBeGreaterThan(40);
      expect(binding.remainingGap.length).toBeGreaterThan(40);
      expect(new Set(binding.tasks.map(t => t.taskId)).size).toBe(1);
      for (const ref of binding.lessons) expect(ref.fingerprint).toBe(lessonFingerprint(module.lessons.find(l => l.id === ref.lessonId)!));
    }
    const report = deriveCoverage(catalog);
    expect(report.totals).toMatchObject({objectiveCount: 13, statementCount: 60, bulletCount: 59, referralCount: 1, mappedStatementCount: 9,
      partialInstructionCount: 16, reviewedPracticeCount: 17, sourceCheckedTaskCount: 51, humanReviewedTaskCount: 0, independentEvidenceCount: 0, gapCount: 60});
    for (const statement of official) {
      const row = report.statements.find(s => s.statementId === statement.id)!;
      expect(row.text).toBe(statement.text);
      expect(row.partialInstruction.length).toBeGreaterThan(0);
      expect(row.reviewedPractice.length).toBeGreaterThan(0);
      expect(row).toMatchObject({independentEvidence: [], pendingJudgments: [], complete: false});
    }
    expect(report.objectives.every(o => !o.complete && o.gaps.length > 0)).toBe(true);
  });
});

describe('Objective 0002/0003 evidence boundaries and authoring safety', () => {
  it('reproduces the append-only recipe and rejects stale reviews or same-version conflicts atomically', () => {
    const testRoot = resolve('tests');
    const dir = mkdtempSync(resolve(testRoot, '.authoring-check-'));
    // Validate before try so the cleanup guard cannot replace a test failure.
    if (!resolve(dir).startsWith(testRoot + sep)) throw new Error('Unsafe authoring test cleanup target');
    try {
      for (const name of ['author-seed.ts', ...['obj0001', 'obj0002-0003'].flatMap(prefix => [`${prefix}-sources.json`, `${prefix}-module.json`, `${prefix}-review.json`])]) {
        copyFileSync(resolve('content', name), resolve(dir, name));
      }
      const path = resolve(dir, 'catalog.json');
      writeFileSync(path, JSON.stringify(baseline, null, 2) + '\n');
      const run = () => execFileSync(process.execPath, ['--experimental-strip-types', resolve(dir, 'author-seed.ts')], {cwd: dir, stdio: 'pipe'});
      run();
      const first = readFileSync(path);
      expect(JSON.parse(first.toString('utf8'))).toEqual(catalog);
      run();
      expect(readFileSync(path)).toEqual(first);
      for (const [kind, id] of [['tasks', checks[0].id], ['sources', sources[0].id], ['reviewEvents', String(reviews[0].id)]]) {
        const conflict = structuredClone(catalog) as unknown as Record<string, Record<string, unknown>[]>;
        conflict[kind].find(r => r.id === id)!.unexpectedConflict = true;
        const bytes = JSON.stringify(conflict);
        writeFileSync(path, bytes);
        expect(run).toThrow(/Immutable catalog conflict/);
        expect(readFileSync(path, 'utf8')).toBe(bytes);
      }
      writeFileSync(path, first);
      const changed = structuredClone(module);
      changed.tasks[0].prompt += ' Unreviewed mutation.';
      writeFileSync(resolve(dir, 'obj0002-0003-module.json'), JSON.stringify(changed));
      expect(run).toThrow(/Missing or stale model comparison/);
      expect(readFileSync(path)).toEqual(first);
    } finally {
      // Only a newly created child of this repository's tests directory is removed.
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it('reads and plans without evidence writes and reseeds original answers/history additively', () => {
    const live = structuredClone(baseline), s = store(live);
    const answer = '  Synthetic original answer\nSpacing and accent: é.  ';
    s.submit({taskId: 'task.obj0001.community-archive-case', taskVersion: 1, answer, hintCount: 0}, 'synthetic-before-slice');
    const before = s.exportData();
    Object.assign(live, structuredClone(catalog));
    s.transaction(() => s.seedCatalog());
    s.transaction(() => s.seedCatalog());
    const after = s.exportData();
    expect(after.attempts).toEqual(before.attempts);
    expect(after.attempts[0].originalAnswer).toBe(answer);
    expect(after.judgments).toEqual(before.judgments);
    expect(after.evidenceEvents).toEqual(before.evidenceEvents);
    for (const key of ['sources', 'tasks', 'mentorTexts', 'rubrics'] as const) expect(after.catalog[key].slice(0, before.catalog[key].length)).toEqual(before.catalog[key]);
    const state = s.state();
    deriveCoverage(catalog, state);
    const planningState: PlannerState = {
      attempts: state.attempts,
      judgments: state.judgments,
      evidenceEvents: state.evidenceEvents,
      taskVersions: state.taskVersions,
    };
    planSession({catalog, state: planningState, now: '2026-11-08T12:00:00Z'});
    expect(s.state()).toEqual(state);
    const fresh = store().state();
    expect(fresh).toMatchObject({attempts: [], judgments: [], evidenceEvents: [], drafts: []});
  });

  it('holds nuanced and stereotyped case responses pending without keyword judgments or transfer evidence', () => {
    for (const item of cases) {
      const s = store();
      for (const answer of [
        'Synthetic reasoned plan: preserve the task goal, collect individual observations, offer competent interpretation and optional support; uncertainty remains.',
        'Synthetic flawed response: all newcomers have trauma; family language proves EL status and disability; absent PTA attendance proves lack of care.',
        'SLIFE newcomer refugee LTEL privacy assets ELPAC competent interpretation',
      ]) {
        const result = s.submit({taskId: item.id, taskVersion: item.version, answer, hintCount: 0}, 'synthetic-case');
        expect(result.attempt.originalAnswer).toBe(answer);
        expect(result.judgment.result).toMatchObject({status: 'needs_review', provisional: true});
        expect(result.judgment.result.feedback).toMatch(/human judgment/);
        expect(result.judgment.quotedEvidence).toEqual([]);
        expect(result.evidenceEvents.every(e => !e.eligible && e.evidenceKind === 'pending')).toBe(true);
        const report = deriveCoverage(catalog, s.state());
        expect(report.statements.some(row => row.pendingJudgments.includes(result.attempt.id))).toBe(true);
        expect(report.totals.independentEvidenceCount).toBe(0);
      }
      const state = s.state();
      for (const skillId of item.skillIds) {
        expect(getReadiness(skillId, catalog, state.attempts, state.judgments, state.evidenceEvents, state.taskVersions)).toMatchObject({status: 'exposed', eligibleCount: 0});
      }
    }
  });

  it('retains correlated starter/0001 and SLIFE families inside the delayed independence window', () => {
    const correlations = [
      ['task.obj0002.profile-planning', 'task.preserve-demand'],
      ['task.obj0003.preference-status', 'task.translation-preference'],
      ['task.obj0003.preference-status', 'task.obj0001.family-access'],
      ['task.obj0002.slife-characteristics', 'task.obj0002.slife-criteria'],
    ];
    for (const [id, oldId] of correlations) {
      const current = task(id), old = catalog.tasks.find(t => t.id === oldId)!;
      expect(current.familyId).toBe(old.familyId);
      const prior = {id: 'synthetic-prior', taskId: old.id, taskVersion: old.version, exposureGroupId: old.familyId, startedAt: '2026-11-01T12:00:00Z', submittedAt: '2026-11-01T12:00:00Z', hintCount: 0, assistance: []};
      const immediate = {...prior, id: 'synthetic-current', taskId: current.id, exposureGroupId: current.familyId, startedAt: '2026-11-01T13:00:00Z', submittedAt: '2026-11-01T13:00:00Z'};
      expect(getAttemptEligibility(immediate, [prior, immediate]).eligible).toBe(false);
      const isolated = {...catalog, tasks: [current]}, state = {...empty(), attempts: [prior], taskVersions: catalog.tasks};
      expect(planSession({catalog: isolated, state, now: '2026-11-01T13:00:00Z'}).recommendations[0]).toMatchObject({kind: 'gap', independence: 'unavailable'});
      expect(planSession({catalog: isolated, state, now: '2026-11-02T12:00:00Z'}).recommendations[0]).toMatchObject({taskId: current.id, independence: 'potentially_independent'});
    }
  });

  it('uses only explicit task scopes in planner tracks and excludes assisted/draft success from mastery', () => {
    for (const item of module.tasks) {
      const isolated = {...catalog, tasks: [item]};
      const recommendation = planSession({catalog: isolated, state: empty(), now: '2026-11-08T12:00:00Z'}).recommendations.find(r => r.taskId === item.id)!;
      expect(recommendation).toBeDefined();
      expect(recommendation.track).toBe(item.kind === 'case' ? 'APPLICATION_TRANSFER' : 'RETRIEVAL');
      expect(recommendation.independence).toBe(item.kind === 'case' ? 'pending_review' : 'potentially_independent');
      expect(recommendation.reasons.join(' ')).toMatch(/Explicit partial practice scope: mtel56.obj.000[23]/);
      const draft = {...isolated, tasks: [{...item, reviewState: 'draft' as const}]};
      expect(planSession({catalog: draft, state: empty(), now: '2026-11-08T12:00:00Z'}).recommendations.every(r => r.taskId !== item.id)).toBe(true);
    }
    const s = store(), item = checks[0];
    s.saveDraft(item.id, item.version, {answer: item.answerKey!.accepted[0], hintCount: 1});
    expect(s.state().attempts).toEqual([]);
    const assisted = s.submit({taskId: item.id, taskVersion: item.version, answer: item.answerKey!.accepted[0], hintCount: 1}, 'synthetic-assisted');
    expect(assisted.judgment.result.status).toBe('correct');
    expect(assisted.evidenceEvents.every(e => !e.eligible)).toBe(true);
    expect(deriveCoverage(catalog, s.state()).totals.independentEvidenceCount).toBe(0);
  });

  it('limits a finite success to its reviewed distinction and never widens historical task evidence', () => {
    for (const item of checks) {
      const s = store();
      const result = s.submit({taskId: item.id, taskVersion: item.version, answer: item.answerKey!.accepted[0], hintCount: 0}, 'synthetic-scoped-success');
      const report = deriveCoverage(catalog, s.state());
      const observations = report.statements.flatMap(row => row.independentEvidence.filter(e => e.attemptId === result.attempt.id).map(e => ({statementId: row.statementId, scope: e.scope})));
      const binding = scopeBindings.find(b => b.tasks.some(t => t.taskId === item.id))!;
      expect(observations).toEqual([{statementId: binding.statementId, scope: binding.scope}]);
      expect(report.objectives.every(o => !o.complete && o.gaps.length > 0)).toBe(true);
    }
    const s = store();
    for (const id of ['task.preserve-demand', 'task.obj0001.family-access']) {
      const old = baseline.tasks.find(t => t.id === id)!;
      s.submit({taskId: id, taskVersion: old.version, answer: old.answerKey!.accepted[0], hintCount: 0}, 'synthetic-legacy-success');
    }
    const sliceRows = deriveCoverage(catalog, s.state()).statements.filter(row => /^mtel56\.obj\.000[23]\./.test(row.statementId));
    expect(sliceRows.every(row => row.independentEvidence.length === 0)).toBe(true);
  });
});
