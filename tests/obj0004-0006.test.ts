import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {afterEach, describe, expect, it} from 'vitest';
import {getAttemptEligibility, getReadiness, type Catalog, validateCatalog} from '../packages/shared/src/index.js';
import {deriveCoverage} from '../packages/shared/src/coverage.js';
import {SOURCE_COVERAGE_CONTRACT} from '../packages/shared/src/coverage-contract.js';
import {planSession, type PlannerState} from '../packages/shared/src/planner.js';
import {SeiStore} from '../apps/server/src/store.js';
import {readObjectives456Baseline} from './obj0004-0006-baseline';
import {SOURCE_COVERAGE_CONTRACT as baseContract} from './fixtures/coverage-contract-189d52fd001240b7fb5f18eaeea47e50ba1de575';

const read = (name: string) => JSON.parse(readFileSync(name, 'utf8'));
const catalog = read('content/catalog.json') as Catalog;
const baseline = readObjectives456Baseline();
const module = read('content/obj0004-0006-module.json') as Pick<Catalog, 'lessons' | 'tasks' | 'cards'>;
const checks = module.tasks.filter(t => t.kind === 'mc');
const cases = module.tasks.filter(t => t.kind === 'case');
const bindings = SOURCE_COVERAGE_CONTRACT.slice(baseContract.length);
const task = (suffix: string) => module.tasks.find(t => t.id === `task.${suffix}`)!;
const empty = (): PlannerState => ({attempts: [], judgments: [], evidenceEvents: [], drafts: []});
const stores: SeiStore[] = [];
const store = (value = catalog) => {
  const s = new SeiStore(value, ':memory:', false, () => new Date('2026-11-09T12:00:00.000Z'));
  stores.push(s);
  return s;
};
afterEach(() => stores.splice(0).forEach(s => s.close()));

describe('Objectives 0004–0006 append-only curriculum and evidence boundaries', () => {
  it('passes portable exact-history, scopes, keys, source, review-hash, card and author-recipe checks without Git', () => {
    expect(validateCatalog(catalog)).toEqual([]);
    const output = execFileSync(process.execPath, ['--experimental-strip-types', 'scripts/verify-obj0004-0006.mjs'], {encoding: 'utf8'});
    expect(output).toMatch(/# fail 0/);
  }, 20000);

  it('retains sixteen exact official statement texts, explicit gaps and zero seeded evidence', () => {
    const official = baseline.statements.filter(s => /^mtel56\.obj\.000[456]\./.test(s.id));
    expect(official).toHaveLength(16);
    const report = deriveCoverage(catalog);
    for (const statement of official) {
      expect(catalog.statements.find(s => s.id === statement.id)).toEqual(statement);
      const row = report.statements.find(s => s.statementId === statement.id)!;
      expect(row.text).toBe(statement.text);
      expect(row.partialInstruction.length).toBeGreaterThan(0);
      expect(row.gaps.length).toBeGreaterThan(0);
      expect(row).toMatchObject({independentEvidence: [], pendingJudgments: [], complete: false, needsRecheck: false});
      const bound = bindings.filter(b => b.statementId === statement.id).flatMap(b => b.tasks.map(t => t.taskId));
      expect([...new Set(row.reviewedPractice.filter(t => module.tasks.some(m => m.id === t.taskId)).map(t => t.taskId))].sort()).toEqual([...new Set(bound)].sort());
    }
    expect(report.totals.independentEvidenceCount).toBe(0);
    expect(report.totals.humanReviewedTaskCount).toBe(0);
    expect(report.objectives.every(o => !o.complete && o.gaps.length > 0)).toBe(true);
    expect(store().state()).toMatchObject({attempts: [], judgments: [], evidenceEvents: [], drafts: []});
  });

  it('grades every MC option with its own source-specific rationale and narrow observation scope', () => {
    for (const item of checks) {
      for (const option of item.options!) {
        const s = store();
        const result = s.submit({taskId: item.id, taskVersion: item.version, answer: option.id, hintCount: 0}, 'synthetic-finite-choice');
        const correct = item.answerKey!.accepted.includes(option.id);
        expect(result.attempt.originalAnswer).toBe(option.id);
        expect(result.judgment.result).toMatchObject({status: correct ? 'correct' : 'incorrect', provisional: false, sourceChecked: true,
          feedback: correct ? item.answerKey!.feedback : item.answerKey!.wrongFeedback[option.id]});
        const report = deriveCoverage(catalog, s.state());
        const observations = report.statements.flatMap(row => row.independentEvidence.filter(e => e.attemptId === result.attempt.id)
          .map(e => ({statementId: row.statementId, scope: e.scope})));
        const binding = bindings.find(b => b.tasks.some(t => t.taskId === item.id))!;
        expect(observations).toEqual(correct ? [{statementId: binding.statementId, scope: binding.scope}] : []);
        expect(report.objectives.every(o => !o.complete)).toBe(true);
      }
    }
  }, 20000);

  it('keeps nuanced cases provisional/manual even for keyword lists, flawed reasoning and plausible plans', () => {
    for (const item of cases) {
      const s = store();
      for (const answer of [
        'Synthetic reasoned plan: retain demanding content, compare audience and domain observations, rehearse with supports, check uncertainty and adjust with justification.',
        'Synthetic flawed plan: English proficiency proves low cognitive ability, so remove complex texts and assign a national learning style.',
        'PLD cognate false cognate polysemy morphology register audience rigor oral rehearsal WIDA S5',
      ]) {
        const result = s.submit({taskId: item.id, taskVersion: item.version, answer, hintCount: 0}, 'synthetic-manual-case');
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

  it('retains correlated exposure families and the existing delayed independence window', () => {
    const correlations = [
      ['obj0005.domain-profile', 'task.uneven-profile'],
      ['obj0005.pld-boundary', 'task.obj0001.language-disability'],
      ['obj0005.risk-and-rigor', 'task.preserve-demand'],
      ['obj0006.content-talk', 'task.rehearsal-bridge'],
      ['obj0005.sci-esl', 'task.shared-plan'],
    ];
    for (const [suffix, oldId] of correlations) {
      const current = task(suffix), old = baseline.tasks.find(t => t.id === oldId)!;
      expect(current.familyId).toBe(old.familyId);
      const prior = {id: 'synthetic-prior', taskId: old.id, taskVersion: old.version, exposureGroupId: old.familyId,
        startedAt: '2026-11-01T12:00:00Z', submittedAt: '2026-11-01T12:00:00Z', hintCount: 0, assistance: []};
      const immediate = {...prior, id: 'synthetic-current', taskId: current.id, exposureGroupId: current.familyId,
        startedAt: '2026-11-01T13:00:00Z', submittedAt: '2026-11-01T13:00:00Z'};
      expect(getAttemptEligibility(immediate, [prior, immediate]).eligible).toBe(false);
      const isolated = {...catalog, tasks: [current]}, state = {...empty(), attempts: [prior], taskVersions: catalog.tasks};
      expect(planSession({catalog: isolated, state, now: '2026-11-01T13:00:00Z'}).recommendations[0]).toMatchObject({kind: 'gap', independence: 'unavailable'});
      expect(planSession({catalog: isolated, state, now: '2026-11-02T12:00:00Z'}).recommendations[0]).toMatchObject({taskId: current.id, independence: 'potentially_independent'});
    }
  });

  it('does not turn reading, drafts or hinted practice into independent evidence', () => {
    const s = store();
    const before = s.state();
    for (const lesson of module.lessons) expect(lesson.body).toMatch(/assisted/i);
    deriveCoverage(catalog, before);
    planSession({catalog, state: before, now: '2026-11-09T12:00:00Z'});
    expect(s.state()).toEqual(before);
    for (const item of module.tasks) {
      const isolated = {...catalog, tasks: [item]};
      const rec = planSession({catalog: isolated, state: empty(), now: '2026-11-09T12:00:00Z'}).recommendations.find(r => r.taskId === item.id)!;
      expect(rec.track).toBe(item.kind === 'case' ? 'APPLICATION_TRANSFER' : 'RETRIEVAL');
      expect(rec.independence).toBe(item.kind === 'case' ? 'pending_review' : 'potentially_independent');
      expect(rec.reasons.join(' ')).toMatch(/Explicit partial practice scope: mtel56.obj.000[456]/);
      const draft = {...isolated, tasks: [{...item, reviewState: 'draft' as const}]};
      expect(planSession({catalog: draft, state: empty(), now: '2026-11-09T12:00:00Z'}).recommendations.every(r => r.taskId !== item.id)).toBe(true);
    }
    const item = checks[0];
    s.saveDraft(item.id, item.version, {answer: item.answerKey!.accepted[0], hintCount: 1});
    expect(s.state().attempts).toEqual([]);
    const result = s.submit({taskId: item.id, taskVersion: item.version, answer: item.answerKey!.accepted[0], hintCount: 1}, 'synthetic-assisted');
    expect(result.judgment.result.status).toBe('correct');
    expect(result.evidenceEvents.every(e => !e.eligible)).toBe(true);
    expect(deriveCoverage(catalog, s.state()).totals.independentEvidenceCount).toBe(0);
  });

  it('appends sources and tasks without changing earlier answers, judgments or evidence', () => {
    const live = structuredClone(baseline), s = store(live);
    const answer = '  Synthetic original answer\nSpacing and accent: é.  ';
    s.submit({taskId: 'task.obj0001.community-archive-case', taskVersion: 1, answer, hintCount: 0}, 'synthetic-before-456');
    const before = s.exportData();
    Object.assign(live, structuredClone(catalog));
    s.transaction(() => s.seedCatalog());
    s.transaction(() => s.seedCatalog());
    const after = s.exportData();
    expect(after.attempts).toEqual(before.attempts);
    expect(after.attempts[0].originalAnswer).toBe(answer);
    expect(after.judgments).toEqual(before.judgments);
    expect(after.evidenceEvents).toEqual(before.evidenceEvents);
    for (const key of ['sources', 'tasks', 'mentorTexts', 'rubrics'] as const) {
      expect(after.catalog[key].slice(0, before.catalog[key].length)).toEqual(before.catalog[key]);
    }
  });

  it('reviews all six new native cards as recall supports without creating attempts or mastery', () => {
    const s = store();
    const initial = s.state();
    expect(s.native.queue().queue).toEqual([]);
    expect(s.native.initialize()).toEqual({initialized: catalog.cards.length});
    expect(s.native.queue().queue).toHaveLength(catalog.cards.length);
    for (const card of module.cards) {
      const queue = s.native.queue();
      const item = queue.queue.find(i => i.card.id === card.id)!;
      expect(item.card).toEqual(card);
      s.native.review({clientEventId: randomUUID(), cardId: card.id, cardFingerprint: item.cardFingerprint,
        expectedVersion: item.version, clientNow: queue.serverNow, startedAt: queue.serverNow,
        revealedAt: queue.serverNow, revealed: true, response: 'Synthetic recalled explanation', hintCount: 0, assistance: [], rating: 3});
    }
    const after = s.state();
    expect(after.attempts).toEqual(initial.attempts);
    expect(after.judgments).toEqual(initial.judgments);
    expect(after.evidenceEvents).toEqual(initial.evidenceEvents);
    expect(deriveCoverage(catalog, after).totals.independentEvidenceCount).toBe(0);
  });

  it('enrolls appended cards while retaining earlier native snapshots, responses and scheduling history', () => {
    const live = structuredClone(baseline), s = store(live);
    expect(s.native.initialize()).toEqual({initialized: baseline.cards.length});
    const queue = s.native.queue(), first = queue.queue[0];
    const original = '  Synthetic earlier recall\nOriginal spacing: é.  ';
    s.native.review({clientEventId: randomUUID(), cardId: first.card.id, cardFingerprint: first.cardFingerprint,
      expectedVersion: first.version, clientNow: queue.serverNow, startedAt: queue.serverNow,
      revealedAt: queue.serverNow, revealed: true, response: original, hintCount: 0, assistance: [], rating: 3});
    const history = s.native.history();
    Object.assign(live, structuredClone(catalog));
    expect(s.native.initialize()).toEqual({initialized: module.cards.length});
    expect(s.native.initialize()).toEqual({initialized: 0});
    s.native.rebuild();
    const after = s.native.history();
    expect(after.slice(0, history.length)).toEqual(history);
    expect(after.find(event => event.kind === 'review')?.request).toMatchObject({response: original});
    expect(after.filter(event => event.kind === 'init')).toHaveLength(catalog.cards.length);
    expect(s.state()).toMatchObject({attempts: [], judgments: [], evidenceEvents: []});
  });
});
