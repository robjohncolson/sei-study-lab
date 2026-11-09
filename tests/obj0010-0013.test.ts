import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {afterEach, describe, expect, it} from 'vitest';
import {getAttemptEligibility, getReadiness, ProposalSchema, type Catalog, validateCatalog} from '../packages/shared/src/index.js';
import {deriveCoverage} from '../packages/shared/src/coverage.js';
import {SOURCE_COVERAGE_CONTRACT} from '../packages/shared/src/coverage-contract.js';
import {planSession, type PlannerState} from '../packages/shared/src/planner.js';
import {approveProposal, createHandoff, inspectProposal} from '../apps/server/src/handoff.js';
import {SeiStore} from '../apps/server/src/store.js';
import {readObjectives1013Baseline} from './obj0010-0013-baseline';
import {SOURCE_COVERAGE_CONTRACT as baseContract} from './fixtures/coverage-contract-e4b8bab7d0e2b15b563f99b9e3c9827f3c67381e';

const read = (name: string) => JSON.parse(readFileSync(name, 'utf8'));
const catalog = read('content/catalog.json') as Catalog;
const baseline = readObjectives1013Baseline();
const module = read('content/obj0010-0013-module.json') as Pick<Catalog, 'lessons' | 'tasks' | 'cards' | 'mentorTexts'>;
const checks = module.tasks.filter(t => t.kind === 'mc');
const cases = module.tasks.filter(t => t.kind === 'case');
const writing = module.tasks.find(t => t.kind === 'writing')!;
const mentor = module.mentorTexts[0];
const bindings = SOURCE_COVERAGE_CONTRACT.slice(baseContract.length);
const task = (suffix: string) => module.tasks.find(t => t.id === `task.${suffix}`)!;
const empty = (): PlannerState => ({attempts: [], judgments: [], evidenceEvents: [], drafts: []});
const stores: SeiStore[] = [];
const store = (value = catalog) => {
  const s = new SeiStore(value, ':memory:', false, () => new Date('2026-11-09T12:00:00.000Z'));
  stores.push(s);
  return s;
};
const writingAnswer = () => ({mentorTextId: mentor.id, mentorTextVersion: mentor.version, mentorTextHash: mentor.sha256,
  rubricVersionId: writing.rubricVersionId!, parts: Object.fromEntries(writing.parts!.map(part => [part.id,
    `Synthetic ${part.id} response: ${mentor.text.split('\n')[0]}`]))});
afterEach(() => stores.splice(0).forEach(s => s.close()));

describe('Objectives 0010-0013 append-only curriculum and rubric-bound practice', () => {
  it('passes offline fixture, source, review hash, scope, mentor and author-recipe checks', () => {
    expect(validateCatalog(catalog)).toEqual([]);
    const output = execFileSync(process.execPath, ['--experimental-strip-types', '--test-reporter=tap', 'scripts/verify-obj0010-0013.mjs'], {encoding: 'utf8'});
    expect(output).toMatch(/# fail 0/);
    expect(output).toMatch(/^# pass 13$/m);
  }, 20000);

  it('retains eighteen official statements, incomplete objectives and zero seeded evidence', () => {
    const official = baseline.statements.filter(s => /^mtel56\.obj\.001[0-3]\./.test(s.id));
    expect(official).toHaveLength(18);
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

  it('grades every MC option with the authored rationale and only its narrow observation scope', () => {
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

  it('keeps unfamiliar cases provisional/manual for plausible plans, errors and keyword lists', () => {
    for (const item of cases) {
      const s = store();
      for (const answer of [
        'Synthetic reasoned plan: check decoding and language separately, read the original passage, model a causal relation, revise with focused feedback and collect content evidence.',
        'Synthetic flawed plan: English proficiency proves low ability; replace reading and writing forever with oral discussion.',
        'WIDA decoding L1 transfer genre scaffold feedback content language objective rubric',
      ]) {
        const result = s.submit({taskId: item.id, taskVersion: item.version, answer, hintCount: 0}, 'synthetic-manual-case');
        expect(result.attempt.originalAnswer).toBe(answer);
        expect(result.judgment.result).toMatchObject({status: 'needs_review', provisional: true});
        expect(result.judgment.result.feedback).toMatch(/human judgment/);
        expect(result.judgment.quotedEvidence).toEqual([]);
        expect(result.evidenceEvents.every(e => !e.eligible && e.evidenceKind === 'pending')).toBe(true);
        expect(deriveCoverage(catalog, s.state()).totals.independentEvidenceCount).toBe(0);
      }
      const state = s.state();
      for (const skillId of item.skillIds) {
        expect(getReadiness(skillId, catalog, state.attempts, state.judgments, state.evidenceEvents, state.taskVersions)).toMatchObject({status: 'exposed', eligibleCount: 0});
      }
    }
  });

  it('saves exact writing answers with no automatic score or eligible learning evidence', () => {
    const s = store();
    const answer = writingAnswer();
    answer.parts.analysis = '  Synthetic Part I answer\nOriginal spacing and accent: é.  ';
    const before = s.state();
    s.saveDraft(writing.id, writing.version, answer);
    expect(s.state().attempts).toEqual(before.attempts);
    expect(s.state().judgments).toEqual(before.judgments);
    expect(s.state().evidenceEvents).toEqual(before.evidenceEvents);
    const result = s.submit({taskId: writing.id, taskVersion: writing.version, answer, hintCount: 0}, 'synthetic-writing');
    expect(result.attempt.originalAnswer).toEqual(answer);
    expect(result.attempt.mentorText).toEqual({id: mentor.id, version: mentor.version, sha256: mentor.sha256});
    expect(result.judgment.rubricVersionId).toBe('rubric.mtel56.public@1');
    expect(result.judgment.result).toMatchObject({status: 'needs_review', provisional: true});
    expect(result.judgment.result).not.toHaveProperty('holisticScore');
    expect(result.judgment.result).not.toHaveProperty('score');
    expect(result.judgment.quotedEvidence).toEqual([]);
    // Existing store records pending bookkeeping, never scored/eligible evidence.
    expect(result.evidenceEvents.every(e => e.evidenceKind === 'pending' && !e.eligible)).toBe(true);
    expect(deriveCoverage(catalog, s.state()).totals.independentEvidenceCount).toBe(0);
    const saved = s.state().attempts[0];
    const {packet, markdown} = createHandoff(s, {attemptId: saved.id, includeAnswer: true, includePrompt: true, includeRubric: true});
    expect(packet.mentorText).toEqual(mentor);
    expect(packet.rubric).toEqual(baseline.rubrics[0]);
    expect(packet.rubricVersion).toBe('rubric.mtel56.public@1');
    expect(packet.originalAnswer).toEqual(answer);
    expect(packet.scorer.label).toBe('manual-grok-handoff');
    expect(packet.returnContract).toMatchObject({provisional: true, holisticScore: null, criteriaFeedback: [], proposedEvidence: []});
    expect(markdown).toMatch(/Nothing is sent automatically/);
    expect(s.state().attempts[0]).toEqual(saved);
    expect(s.state().models).toMatchObject({enabled: false, calls: 0});
  });

  it('rejects substituted mentor identities, changed hashes, missing parts and wrong rubric versions', () => {
    const s = store();
    const answer = writingAnswer();
    const submit = (changed: unknown) => s.submit({taskId: writing.id, taskVersion: writing.version, answer: changed, hintCount: 0}, 'synthetic-invalid-writing');
    for (const changed of [
      {...answer, mentorTextId: baseline.mentorTexts[0].id}, {...answer, mentorTextVersion: 99},
      {...answer, mentorTextHash: '0'.repeat(64)}, {...answer, rubricVersionId: 'rubric.invented@1'},
      {...answer, parts: {analysis: 'Only one part'}}, {...answer, parts: {...answer.parts, sixth: 'Unauthorized part'}},
    ]) expect(() => submit(changed)).toThrow(/mentor|rubric|five/);
    expect(s.state()).toMatchObject({attempts: [], judgments: [], evidenceEvents: []});
  });

  it('accepts criterion comments and one provisional holistic score but rejects numeric criterion fields', () => {
    const s = store();
    const {attempt} = s.submit({taskId: writing.id, taskVersion: writing.version, answer: writingAnswer(), hintCount: 0}, 'synthetic-packet');
    const {packet} = createHandoff(s, {attemptId: attempt.id, includeAnswer: true});
    const criterion = {criterionId: 'support', comment: 'The response quotes the same mentor passage; the explanation still needs human review.',
      answerQuotes: ['Synthetic analysis response'], missingEvidence: ['Explain how the quoted passage supports the instructional decision.']};
    const proposal = {...packet.returnContract, judgeLabel: 'Synthetic manual reviewer', criteriaFeedback: [criterion], holisticScore: 3,
      needsHumanReview: true, reason: 'Provisional practice feedback with an unresolved rationale gap.', proposedEvidence: []};
    const before = s.state();
    for (const score of [1, 2, 3, 4, 'U', 'B', null]) {
      expect(ProposalSchema.safeParse({...proposal, holisticScore: score}).success).toBe(true);
    }
    expect(inspectProposal(s, proposal).proposal).toMatchObject({holisticScore: 3, provisional: true});
    for (const field of ['score', 'numericScore', 'rating', 'weight', 'points', 'weightedScore']) {
      expect(ProposalSchema.safeParse({...proposal, criteriaFeedback: [{...criterion, [field]: 2}]}).success).toBe(false);
    }
    expect(ProposalSchema.safeParse({...proposal, analyticScores: {purpose: 3, support: 2}}).success).toBe(false);
    expect(ProposalSchema.safeParse({...proposal, provisional: false}).success).toBe(false);
    expect(ProposalSchema.safeParse({...proposal, holisticScore: 2.5}).success).toBe(false);
    expect(s.state()).toEqual(before);
    // Explicit synthetic approval exercises the existing manual path; it is not human adjudication.
    approveProposal(s, proposal);
    const after = s.state();
    expect(after.attempts).toEqual(before.attempts);
    expect(after.judgments).toHaveLength(before.judgments.length + 1);
    expect(after.judgments.at(-1)!.result).toMatchObject({status: 'needs_review', provisional: true, sourceChecked: false,
      proposal: {holisticScore: 3, provisional: true}});
    expect(after.evidenceEvents.every(e => !e.eligible && e.evidenceKind === 'pending')).toBe(true);
    expect(deriveCoverage(catalog, after).totals.independentEvidenceCount).toBe(0);
  });

  it('retains correlated families and delayed independence rather than treating variants as fresh evidence', () => {
    for (const [suffix, oldId] of [
      ['obj0012.language-concept', 'task.grammar-content'], ['obj0010.chunk-access', 'task.preserve-demand'],
      ['obj0012.dual-evidence', 'task.obj0007.dual-objectives'], ['obj0011.oral-entry', 'task.rehearsal-bridge'],
    ]) {
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

  it('does not convert lessons, drafts, hinted checks or planning into independent evidence', () => {
    const s = store(), before = s.state();
    for (const lesson of module.lessons) expect(lesson.body).toMatch(/assisted/i);
    deriveCoverage(catalog, before);
    planSession({catalog, state: before, now: '2026-11-09T12:00:00Z'});
    expect(s.state()).toEqual(before);
    const item = checks[0];
    s.saveDraft(item.id, item.version, {answer: item.answerKey!.accepted[0], hintCount: 1});
    expect(s.state().attempts).toEqual([]);
    const result = s.submit({taskId: item.id, taskVersion: item.version, answer: item.answerKey!.accepted[0], hintCount: 1}, 'synthetic-assisted');
    expect(result.judgment.result.status).toBe('correct');
    expect(result.evidenceEvents.every(e => !e.eligible)).toBe(true);
    expect(deriveCoverage(catalog, s.state()).totals.independentEvidenceCount).toBe(0);
    for (const current of module.tasks) {
      const isolated = {...catalog, tasks: [{...current, reviewState: 'draft' as const}]};
      expect(planSession({catalog: isolated, state: empty(), now: '2026-11-09T12:00:00Z'}).recommendations.every(r => r.taskId !== current.id)).toBe(true);
    }
  });

  it('preserves earlier writing answers, judgments, evidence and rubric/mentor snapshots through reseeding', () => {
    const live = structuredClone(baseline), s = store(live);
    const old = baseline.tasks.find(t => t.kind === 'writing')!, oldMentor = baseline.mentorTexts.find(m => m.id === old.mentorTextId)!;
    const answer = {mentorTextId: oldMentor.id, mentorTextVersion: oldMentor.version, mentorTextHash: oldMentor.sha256,
      parts: Object.fromEntries(old.parts!.map(p => [p.id, '  Synthetic earlier response\nOriginal spacing: é.  ']))};
    s.submit({taskId: old.id, taskVersion: old.version, answer, hintCount: 0}, 'synthetic-before-1013');
    const before = s.exportData();
    Object.assign(live, structuredClone(catalog));
    s.transaction(() => s.seedCatalog());
    s.transaction(() => s.seedCatalog());
    const after = s.exportData();
    expect(after.attempts).toEqual(before.attempts);
    expect(after.attempts[0].originalAnswer).toEqual(answer);
    expect(after.judgments).toEqual(before.judgments);
    expect(after.evidenceEvents).toEqual(before.evidenceEvents);
    for (const key of ['sources', 'tasks', 'mentorTexts', 'rubrics'] as const) {
      expect(after.catalog[key].slice(0, before.catalog[key].length)).toEqual(before.catalog[key]);
    }
  });

  it('reviews eight new source-bound cards without producing attempts, judgments or evidence', () => {
    const s = store(), before = s.state();
    expect(s.native.initialize()).toEqual({initialized: catalog.cards.length});
    for (const card of module.cards) {
      const queue = s.native.queue(), item = queue.queue.find(i => i.card.id === card.id)!;
      expect(item.card).toEqual(card);
      s.native.review({clientEventId: randomUUID(), cardId: card.id, cardFingerprint: item.cardFingerprint,
        expectedVersion: item.version, clientNow: queue.serverNow, startedAt: queue.serverNow,
        revealedAt: queue.serverNow, revealed: true, response: 'Synthetic recalled explanation', hintCount: 0, assistance: [], rating: 3});
    }
    const after = s.state();
    expect(after.attempts).toEqual(before.attempts);
    expect(after.judgments).toEqual(before.judgments);
    expect(after.evidenceEvents).toEqual(before.evidenceEvents);
  });

  it('enrolls appended cards while preserving earlier recall text and scheduler event history', () => {
    const live = structuredClone(baseline), s = store(live);
    expect(s.native.initialize()).toEqual({initialized: baseline.cards.length});
    const queue = s.native.queue(), first = queue.queue[0];
    const response = '  Synthetic earlier recall\nOriginal spacing: é.  ';
    s.native.review({clientEventId: randomUUID(), cardId: first.card.id, cardFingerprint: first.cardFingerprint,
      expectedVersion: first.version, clientNow: queue.serverNow, startedAt: queue.serverNow,
      revealedAt: queue.serverNow, revealed: true, response, hintCount: 0, assistance: [], rating: 3});
    const history = s.native.history();
    Object.assign(live, structuredClone(catalog));
    expect(s.native.initialize()).toEqual({initialized: module.cards.length});
    expect(s.native.initialize()).toEqual({initialized: 0});
    s.native.rebuild();
    const after = s.native.history();
    expect(after.slice(0, history.length)).toEqual(history);
    expect(after.find(event => event.kind === 'review')?.request).toMatchObject({response});
    expect(after.filter(event => event.kind === 'init')).toHaveLength(catalog.cards.length);
    expect(s.state()).toMatchObject({attempts: [], judgments: [], evidenceEvents: []});
  });
});
