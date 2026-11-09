import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {afterEach, describe, expect, it} from 'vitest';
import {getAttemptEligibility, type Catalog, validateCatalog} from '../packages/shared/src/index.js';
import {deriveCoverage} from '../packages/shared/src/coverage.js';
import {planSession, type PlannerState} from '../packages/shared/src/planner.js';
import {SeiStore} from '../apps/server/src/store.js';
import {readBaselineCatalog} from './catalog-baseline';

const catalog = JSON.parse(readFileSync('content/catalog.json', 'utf8')) as Catalog;
const base = readBaselineCatalog();
const moduleLessonId = 'lesson.obj0001.identification-shared.v1';
const taskId = (suffix: string) => `task.obj0001.${suffix}`;
const sourceId = (n: number) => `source.obj0001.s${n}.2026-11-08`;
const newTasks = catalog.tasks.filter(t => t.id.startsWith('task.obj0001.'));
const newSources = catalog.sources.filter(s => s.id.startsWith('source.obj0001.'));
const standalone = newTasks.filter(t => t.kind === 'mc' || t.kind === 'short');
const task = (suffix: string) => newTasks.find(t => t.id === taskId(suffix))!;
const empty = (): PlannerState => ({attempts: [], judgments: [], evidenceEvents: [], drafts: []});
const stores: SeiStore[] = [];
const store = (value = catalog) => {
  const s = new SeiStore(value, ':memory:');
  stores.push(s);
  return s;
};
afterEach(() => stores.splice(0).forEach(s => s.close()));

describe('Objective 0001 supplied-packet curriculum boundaries', () => {
  it('appends content without changing any installed inventory or versioned record', () => {
    expect(validateCatalog(catalog)).toEqual([]);
    for (const [key, oldRows] of Object.entries(base)) {
      if (!Array.isArray(oldRows)) {
        expect(catalog[key as keyof Catalog]).toEqual(oldRows);
        continue;
      }
      const current = catalog[key as keyof Catalog] as {id: string; version?: string | number}[];
      for (const old of oldRows as {id: string; version?: string | number}[]) {
        expect(current.find(row => row.id === old.id && String(row.version) === String(old.version)), `${key}: ${old.id}`).toEqual(old);
      }
    }
    for (const key of ['objectives', 'statements', 'competencies', 'indicators', 'alignments', 'skills', 'prerequisites', 'mentorTexts', 'rubrics', 'cards'] as const) {
      expect(key === 'cards' ? catalog.cards.slice(0, base.cards.length) : catalog[key]).toEqual(base[key]);
    }
    expect(catalog.objectives).toHaveLength(13);
    expect(catalog.statements).toHaveLength(60);
    // Preserve the exact first-wave count while permitting later additive slices.
    expect(catalog.lessons.filter(l => base.lessons.some(old => old.id === l.id) || l.id === moduleLessonId)).toHaveLength(base.lessons.length + 1);
    expect(catalog.tasks.filter(t => base.tasks.some(old => old.id === t.id) || t.id.startsWith('task.obj0001.'))).toHaveLength(base.tasks.length + 8);
  });

  it('provides exactly seven conceptual families and one separate unfamiliar case', () => {
    expect(standalone.map(t => t.id).sort()).toEqual([
      'evidence-chain', 'family-access', 'shared-services', 'notice-record', 'opt-out', 'fel-support', 'language-disability',
    ].map(taskId).sort());
    expect(new Set(standalone.map(t => t.familyId)).size).toBe(7);
    expect(standalone.every(t => t.noveltyKind === 'familiar')).toBe(true);
    expect(newTasks.filter(t => t.kind === 'case')).toHaveLength(1);
    expect(task('community-archive-case')).toMatchObject({kind: 'case', noveltyKind: 'unfamiliar', reviewState: 'source_checked'});
    expect(task('community-archive-case').answerKey).toBeFalsy();
    expect(newTasks.every(t => t.lessonId === moduleLessonId)).toBe(true);
    expect(newTasks.every(t => t.reviewState === 'source_checked')).toBe(true);
  });

  it('retains supplied source identity, dates and binary hashes without claiming human review', () => {
    expect(newSources.map(s => s.id).sort()).toEqual(Array.from({length: 9}, (_, i) => sourceId(i + 1)).sort());
    const hashes: Record<number, string> = {
      5: '6720f402f61ab4cb158eebbede7cfa5e9354edda2ddb1da46a6deddfe7403854',
      6: 'fbfdadd7d8c8ae2c684aae27d17e8204b34760a0dcb3e5339f3777f3d421cbbd',
      7: '127e17d03df6ef48c7a8ed691f4a1596dcb8183942e86bfb423bd6ed8842ef95',
      8: '3ef15cc97628b3b9c33e23632c4239b687014d14232170955ab5a2ce7096cc98',
      9: 'e5ee4b9dcb28aad2cab8261d5bbb72ad7a9493fdb3e91225f8ee8c1abc0751ee',
    };
    for (const source of newSources) {
      expect(source.retrievedAt).toContain('2026-11-08');
      expect(source.reviewState).toBe('source_compared');
      expect(source.excerpt.trim().length).toBeGreaterThan(20);
      expect(source.url).toMatch(/^https:\/\/(www\.mtel\.nesinc\.com|www\.doe\.mass\.edu)\//);
      const n = Number(source.id.match(/\.s(\d)\./)![1]);
      expect(source.sha256).toBe(hashes[n] ?? null);
    }
    expect(JSON.stringify(newSources.find(s => s.id === sourceId(5)))).toContain('June 2025');
    expect(JSON.stringify(newSources.find(s => s.id === sourceId(7)))).toContain('January 2026');
    expect(JSON.stringify(newSources.find(s => s.id === sourceId(9)))).toContain('February 2019');
    const canonical = (value: unknown) => JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b))) : v);
    for (const entity of [...newSources, ...newTasks, catalog.lessons.find(l => l.id === moduleLessonId)!]) {
      const reviews = catalog.reviewEvents.filter(e => e.entityId === entity.id);
      expect(reviews.length, entity.id).toBeGreaterThan(0);
      expect(reviews.every(e => e.reviewerKind === 'model')).toBe(true);
      expect(JSON.stringify(reviews)).toMatch(/supplied|packet/i);
      expect(JSON.stringify(reviews)).toMatch(/not.*human|no.*human/i);
      const digest = createHash('sha256').update(canonical(entity)).digest('hex');
      expect(reviews.some(e => e.payloadSha256 === digest), `${entity.id}: reviewed payload identity`).toBe(true);
    }
  });

  it('bounds automatic keys and gives a source-linked reason for every wrong choice', () => {
    expect(standalone.filter(t => t.kind === 'short')).toHaveLength(1);
    // Separate wording-to-source comparison confirmed these distinctions and choices.
    const reviewedKeys = {'evidence-chain': 'c', 'family-access': 'a', 'shared-services': 'b', 'notice-record': 'd', 'fel-support': 'c', 'language-disability': 'a'};
    for (const [suffix, key] of Object.entries(reviewedKeys)) expect(task(suffix).answerKey!.accepted).toEqual([key]);
    expect(task('opt-out').answerKey!.accepted).toContain('EL');
    expect(task('opt-out').answerKey!.accepted).not.toContain('FEL');
    for (const item of standalone) {
      expect(item.answerKey!.accepted.length).toBeGreaterThan(0);
      expect(item.answerKey!.accepted.every(key => key.trim().length > 0)).toBe(true);
      expect(item.sourceRefs.every(ref => newSources.some(s => s.id === ref))).toBe(true);
      expect(item.sourceRefs.some(ref => item.answerKey!.feedback.includes(ref))).toBe(true);
      if (item.kind !== 'mc') continue;
      expect(item.options).toHaveLength(4);
      expect(item.answerKey!.accepted).toHaveLength(1);
      const wrong = item.options!.filter(option => !item.answerKey!.accepted.includes(option.id));
      expect(Object.keys(item.answerKey!.wrongFeedback).sort()).toEqual(wrong.map(option => option.id).sort());
      for (const option of wrong) {
        const feedback = item.answerKey!.wrongFeedback[option.id];
        expect(feedback.length).toBeGreaterThan(50);
        expect(item.sourceRefs.some(ref => feedback.includes(ref))).toBe(true);
      }
    }
  });

  it('keeps the module partial, preserves all objective gaps and binds its actual tasks', () => {
    const report = deriveCoverage(catalog);
    expect(report.contractVersion).toBeGreaterThan(1);
    expect(report.totals).toMatchObject({objectiveCount: 13, bulletCount: 59, referralCount: 1, humanReviewedTaskCount: 0, independentEvidenceCount: 0});
    expect(report.objectives.every(o => !o.complete && o.gaps.length > 0)).toBe(true);
    const scopes = report.statements.filter(s => ['mtel56.obj.0001.ds.01', 'mtel56.obj.0001.ds.03'].includes(s.statementId));
    expect(scopes.every(s => s.partialInstruction.some(l => l.lessonId === moduleLessonId))).toBe(true);
    for (const item of newTasks) expect(scopes.some(s => s.reviewedPractice.some(p => p.taskId === item.id))).toBe(true);
    expect(report.statements.find(s => s.statementId === 'mtel56.obj.0001.ds.02')!.reviewedPractice).toEqual([]);
    const lesson = catalog.lessons.find(l => l.id === moduleLessonId)!;
    expect(lesson.body).toMatch(/guided/i);
    expect(lesson.body).toMatch(/not independent/i);
    expect(lesson.body).toMatch(/January 2026/);
    expect(lesson.body).toMatch(/2026-11-08/);
    const authoredText = [lesson.body, ...newTasks.map(t => JSON.stringify(t))].join('\n');
    expect(authoredText).not.toMatch(/(?:within|no later than)\s+(?:10|20|30|ten|twenty|thirty)\s+(?:school\s+)?days/i);
    expect(authoredText).not.toMatch(/(?:cut[- ]?score|threshold)\s*(?:is|of|:|=)\s*\d/i);
  });
});

describe('Objective 0001 evidence and historical compatibility', () => {
  it('seeds only catalog records and keeps guided instruction outside attempt/evidence storage', () => {
    const s = store();
    expect(s.state()).toMatchObject({attempts: [], judgments: [], evidenceEvents: [], drafts: []});
    const before = s.state();
    deriveCoverage(catalog, before);
    const planningState: PlannerState = {attempts: before.attempts, judgments: before.judgments, evidenceEvents: before.evidenceEvents, taskVersions: before.taskVersions};
    planSession({catalog, state: planningState, now: '2026-11-08T12:00:00Z'});
    expect(s.state()).toEqual(before);
  });

  it('re-seeds a synthetic v1 database additively without touching original answers or snapshots', () => {
    const liveCatalog = structuredClone(base);
    const s = store(liveCatalog);
    const originalAnswer = '  Synthetic original answer\nwith spacing and accent: é.  ';
    s.submit({taskId: 'task.survey-recall', taskVersion: 1, answer: originalAnswer, hintCount: 0}, 'synthetic-before-upgrade');
    const before = s.exportData();
    Object.assign(liveCatalog, structuredClone(catalog));
    expect(() => s.transaction(() => s.seedCatalog())).not.toThrow();
    expect(() => s.transaction(() => s.seedCatalog())).not.toThrow();
    const after = s.exportData();
    expect(after.attempts).toEqual(before.attempts);
    expect(after.attempts[0].originalAnswer).toBe(originalAnswer);
    expect(after.judgments).toEqual(before.judgments);
    expect(after.evidenceEvents).toEqual(before.evidenceEvents);
    for (const key of ['sources', 'tasks', 'mentorTexts', 'rubrics'] as const) {
      expect(after.catalog[key].slice(0, before.catalog[key].length)).toEqual(before.catalog[key]);
    }
    expect(s.state().taskVersions).toHaveLength(catalog.tasks.length);
    expect(s.existing('tasks', 'task.survey-recall', 1)).toEqual(base.tasks.find(t => t.id === 'task.survey-recall'));
  });

  it('scores finite keys while nuanced short responses and transfer remain pending', () => {
    const s = store();
    for (const item of standalone) {
      const correct = s.submit({taskId: item.id, taskVersion: 1, answer: item.answerKey!.accepted[0], hintCount: 0}, 'synthetic-key');
      expect(correct.judgment.result).toMatchObject({status: 'correct', provisional: false, sourceChecked: true});
      if (item.kind !== 'mc') continue;
      for (const option of item.options!.filter(o => !item.answerKey!.accepted.includes(o.id))) {
        const wrong = s.submit({taskId: item.id, taskVersion: 1, answer: option.id, hintCount: 0}, 'synthetic-distractor');
        expect(wrong.judgment.result).toMatchObject({status: 'incorrect', feedback: item.answerKey!.wrongFeedback[option.id]});
      }
    }
    for (const item of [task('opt-out'), task('community-archive-case')]) {
      const answer = 'Synthetic nuanced explanation: distinguish evidence, coordinate instruction, and preserve uncertainty.';
      const result = s.submit({taskId: item.id, taskVersion: 1, answer, hintCount: 0}, 'synthetic-open');
      expect(result.attempt.originalAnswer).toBe(answer);
      expect(result.judgment.result).toMatchObject({status: 'needs_review', provisional: true});
      expect(result.evidenceEvents.every(e => !e.eligible && e.evidenceKind === 'pending')).toBe(true);
      const report = deriveCoverage(catalog, s.state());
      expect(report.statements.some(row => row.pendingJudgments.includes(result.attempt.id))).toBe(true);
      expect(report.statements.every(row => row.independentEvidence.every(e => e.attemptId !== result.attempt.id))).toBe(true);
    }
  });

  it('keeps four correlated starter families inside the same delayed independence window', () => {
    const correlations = [
      ['evidence-chain', 'task.survey-purpose'],
      ['family-access', 'task.translation-preference'],
      ['shared-services', 'task.shared-plan'],
      ['fel-support', 'task.former-support'],
    ];
    for (const [newSuffix, oldId] of correlations) {
      const current = task(newSuffix), old = base.tasks.find(t => t.id === oldId)!;
      expect(current.familyId).toBe(old.familyId);
      const prior = {id: 'synthetic-prior', taskId: old.id, taskVersion: old.version, exposureGroupId: old.familyId, startedAt: '2026-11-01T12:00:00Z', submittedAt: '2026-11-01T12:00:00Z', hintCount: 0, assistance: []};
      const immediate = {...prior, id: 'synthetic-new', taskId: current.id, exposureGroupId: current.familyId, startedAt: '2026-11-01T13:00:00Z', submittedAt: '2026-11-01T13:00:00Z'};
      expect(getAttemptEligibility(immediate, [prior, immediate]).eligible).toBe(false);
      const isolated = {...catalog, tasks: [current]};
      const state = {...empty(), attempts: [prior], taskVersions: base.tasks};
      const early = planSession({catalog: isolated, state, now: '2026-11-01T13:00:00Z'}).recommendations[0];
      expect(early).toMatchObject({kind: 'gap', independence: 'unavailable'});
      const delayed = planSession({catalog: isolated, state, now: '2026-11-02T12:00:00Z'}).recommendations[0];
      expect(delayed).toMatchObject({taskId: current.id, independence: 'potentially_independent'});
    }
  });

  it('offers every new retrieval task and the case in truthful scoped planner tracks', () => {
    for (const item of newTasks) {
      const current = {...catalog, tasks: [item]};
      const plan = planSession({catalog: current, state: empty(), now: '2026-11-08T12:00:00Z'});
      const recommendation = plan.recommendations.find(r => r.taskId === item.id)!;
      expect(recommendation).toBeDefined();
      expect(recommendation.track).toBe(item.kind === 'case' ? 'APPLICATION_TRANSFER' : 'RETRIEVAL');
      expect(recommendation.independence).toBe(item.kind === 'case' ? 'pending_review' : 'potentially_independent');
      expect(recommendation.reasons.join(' ')).toContain('Explicit partial practice scope: mtel56.obj.0001.');
      expect(recommendation.reasons.join(' ')).toContain('not human validated');
      const unreviewed = {...current, tasks: [{...item, reviewState: 'draft' as const}]};
      expect(planSession({catalog: unreviewed, state: empty(), now: '2026-11-08T12:00:00Z'}).recommendations.every(r => r.taskId !== item.id)).toBe(true);
    }
  });
});
