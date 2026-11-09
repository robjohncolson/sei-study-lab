import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import type {Catalog} from '../packages/shared/src/index.js';
import type {PlannerState} from '../packages/shared/src/planner.js';
import type {FlashcardSummary} from '../packages/shared/src/native-fsrs.js';
import {allocateStudySlices, classifyObjective, estimateStudyPlan, etDate, remainingStudySessions, timeTilt} from '../packages/shared/src/study-estimate.js';

const catalog = JSON.parse(readFileSync('content/catalog.json', 'utf8')) as Catalog;
const now = '2026-12-10T12:00:00-05:00';
const writing = catalog.tasks.find(t => t.id === 'task.writing.mentor.community-archive')!;
const mentor = catalog.mentorTexts.find(m => m.id === writing.mentorTextId)!;
const empty = (): PlannerState => ({attempts: [], judgments: [], evidenceEvents: [], drafts: []});
const cards = (due = 10): FlashcardSummary => ({initialized: true, total: catalog.cards.length, due, new: catalog.cards.length, learning: 0, review: 0, held: 0});
const estimate = (state = empty(), flashcards: FlashcardSummary | null = cards(), current = catalog, at = now) =>
  estimateStudyPlan({catalog: current, state, flashcards, now: at});
const parts = (text: string) => Object.fromEntries(writing.parts!.map(part => [part.id, text]));
const answer = (text: string) => ({mentorTextId: mentor.id, mentorTextVersion: mentor.version, mentorTextHash: mentor.sha256, parts: parts(text)});
const attempt = (id: string, task: Catalog['tasks'][number], submittedAt: string, originalAnswer: unknown = 'synthetic response') =>
  ({id, taskId: task.id, taskVersion: task.version, submittedAt, startedAt: submittedAt, hintCount: 0, assistance: [], originalAnswer});
const feedback = (attemptId: string, createdAt = '2026-12-02T12:00:00Z') =>
  ({id: `feedback-${attemptId}`, attemptId, createdAt, result: {status: 'needs_review', sourceChecked: false, provisional: true}});
const drafted = (text: string): PlannerState => ({...empty(), drafts: [{taskId: writing.id, taskVersion: writing.version, updatedAt: '2026-12-01T12:00:00Z', answer: answer(text)}]});
const revised = (text: string): PlannerState => ({...empty(), attempts: [
  attempt('first', writing, '2026-12-01T12:00:00Z', answer('An initial explanation')),
  attempt('second', writing, '2026-12-03T12:00:00Z', answer(text)),
], judgments: [feedback('first')]});

describe('ET calendar and time tilt', () => {
  it.each([
    ['2026-12-15T23:30:00-05:00', 10, 15, 15],
    ['2026-12-16T00:00:00-05:00', 10, 10, 20],
    ['2027-01-01T23:30:00-05:00', 10, 10, 20],
    ['2027-01-02T00:00:00-05:00', 5, 10, 25],
    ['2027-01-16T23:30:00-05:00', 5, 10, 25],
    ['2027-01-17T00:00:00-05:00', 5, 10, 25],
  ])('uses the date tilt at %s', (at, flashcards, knowledge, essay) => {
    expect(timeTilt(at)).toEqual({flashcards, knowledge, essay});
  });

  it('uses ET even when the UTC date is different and clamps the exam countdown', () => {
    expect(etDate('2026-12-16T04:30:00Z')).toBe('2026-12-15');
    expect(timeTilt('2026-12-16T04:30:00Z')).toEqual({flashcards: 10, knowledge: 15, essay: 15});
    expect(estimate(empty(), cards(), catalog, '2027-01-16T23:30:00-05:00')).toMatchObject({daysUntilExam: 0, examDatePassed: false});
    expect(estimate(empty(), cards(), catalog, '2027-01-17T00:00:00-05:00')).toMatchObject({daysUntilExam: 0, examDatePassed: true});
    expect(estimate(empty(), cards(), catalog, '2026-12-15T23:30:00-05:00').daysUntilExam).toBe(32);
  });

  it('requires a valid injected clock', () => {
    for (const at of ['invalid date', NaN, Infinity]) {
      expect(() => estimateStudyPlan({catalog, state: empty(), flashcards: null, now: at})).toThrow();
    }
  });
});

describe('knowledge estimates extend readiness and statement coverage', () => {
  // The stable fixture injects existing readiness statuses and coverage facts into
  // the pure classifier; readiness promotion itself remains covered by shared tests.
  const stableInput = {readiness: ['independent_evidence', 'transfer_evidence'] as const, statementEvidence: true, statementNeedsRecheck: false, hasAttempts: true, incorrectTasks: 0, statementCount: 4};
  const classified = (overrides: Partial<Parameters<typeof classifyObjective>[0]> = {}) =>
    classifyObjective({...stableInput, readiness: [...stableInput.readiness], ...overrides});

  it('gives a stable objective zero remaining minutes only with both readiness and coverage', () => {
    expect(classified()).toMatchObject({status: 'stable', remainingMinutes: 0, baselineMinutes: 15});
    expect(classified({statementEvidence: false}).status).toBe('started');
    expect(classified({readiness: ['practicing']}).status).toBe('started');
    expect(classified({statementNeedsRecheck: true}).status).toBe('missed');
    expect(classified({readiness: ['needs_recheck']}).status).toBe('missed');
    expect(classified({readiness: []}).status).toBe('stable');
    expect(classified({readiness: [], statementEvidence: false}).status).not.toBe('stable');
  });

  it('projects stable Objective 0001 from real catalog families and synthetic independent evidence', () => {
    const state = empty();
    const ids = ['task.survey-purpose', 'task.translation-preference', 'task.shared-plan', 'task.team-evidence', 'task.former-support', 'task.policy-date'];
    for (const [index, taskId] of ids.entries()) {
      const task = catalog.tasks.find(t => t.id === taskId)!;
      const submittedAt = `2026-11-${String(index * 2 + 1).padStart(2, '0')}T12:00:00Z`;
      const response = attempt(`stable-${index}`, task, submittedAt);
      const judgmentId = `judgment-${response.id}`;
      state.attempts.push(response);
      state.judgments.push({id: judgmentId, attemptId: response.id, createdAt: submittedAt, result: {status: 'correct', sourceChecked: true, provisional: false}});
      for (const skillId of task.skillIds) state.evidenceEvents.push({id: `${response.id}-${skillId}`, attemptId: response.id, judgmentId, skillId, eligible: true});
    }
    const result = estimate(state);
    expect(result.objectives.find(o => o.id === 'mtel56.obj.0001')).toMatchObject({status: 'stable', remainingMinutes: 0});
    expect(result.objectivesStable).toBeGreaterThanOrEqual(1);
    expect(result.knowledgePercent).toBeGreaterThan(0);
  });

  it('gives an unseen focused objective one 15-minute slice and a broad objective 25 minutes', () => {
    const result = estimate();
    expect(result.objectives).toHaveLength(12);
    expect(result.objectives.some(o => o.id.endsWith('0013'))).toBe(false);
    expect(result.objectives.find(o => o.id === 'mtel56.obj.0002')).toMatchObject({status: 'unseen', statementCount: 4, remainingMinutes: 15, baselineMinutes: 15});
    expect(result.objectives.find(o => o.id === 'mtel56.obj.0005')).toMatchObject({status: 'unseen', statementCount: 6, remainingMinutes: 25, baselineMinutes: 25});
    expect(result.knowledgePercent).toBe(0);
  });

  it('adds ten minutes per recent miss signal capped at twenty extra minutes', () => {
    expect(classified({readiness: ['practicing'], statementEvidence: false, incorrectTasks: 1})).toMatchObject({status: 'missed', missSignals: 1, remainingMinutes: 25});
    expect(classified({readiness: ['practicing'], statementEvidence: false, incorrectTasks: 2})).toMatchObject({missSignals: 2, remainingMinutes: 35});
    expect(classified({readiness: ['needs_recheck', 'needs_recheck'], statementNeedsRecheck: true, incorrectTasks: 5})).toMatchObject({missSignals: 6, remainingMinutes: 35});
  });

  it('uses the latest authoritative own-task judgment and ignores provisional supersession', () => {
    const task = catalog.tasks.find(t => t.lessonId === 'lesson.obj0002.diversity.v1' && t.kind === 'mc')!;
    const state = empty();
    state.attempts = [attempt('check', task, '2026-12-01T12:00:00Z')];
    state.judgments = [
      {id: 'wrong', attemptId: 'check', createdAt: '2026-12-01T12:01:00Z', result: {status: 'incorrect', sourceChecked: true, provisional: false}},
      {id: 'proposal', attemptId: 'check', supersedesId: 'wrong', createdAt: '2026-12-02T12:00:00Z', result: {status: 'correct', sourceChecked: true, provisional: true}},
    ];
    expect(estimate(state).objectives.find(o => o.id === 'mtel56.obj.0002')).toMatchObject({status: 'missed', missSignals: 1, remainingMinutes: 25});
    state.judgments.push({id: 'correction', attemptId: 'check', supersedesId: 'wrong', createdAt: '2026-12-03T12:00:00Z', result: {status: 'correct', sourceChecked: true, provisional: false}});
    expect(estimate(state).objectives.find(o => o.id === 'mtel56.obj.0002')).toMatchObject({status: 'started', remainingMinutes: 15});
  });

  it('uses effective judgment chronology when an older attempt receives a late correction', () => {
    const task = catalog.tasks.find(t => t.lessonId === 'lesson.obj0002.diversity.v1' && t.kind === 'mc')!;
    const state = empty();
    state.attempts = [
      attempt('older', task, '2026-12-01T12:00:00Z'),
      attempt('newer', task, '2026-12-03T12:00:00Z'),
    ];
    state.judgments = [
      {id: 'older-correct', attemptId: 'older', createdAt: '2026-12-01T12:01:00Z', result: {status: 'correct', sourceChecked: true, provisional: false}},
      {id: 'newer-correct', attemptId: 'newer', createdAt: '2026-12-03T12:01:00Z', result: {status: 'correct', sourceChecked: true, provisional: false}},
      {id: 'late-correction', attemptId: 'older', supersedesId: 'older-correct', createdAt: '2026-12-05T12:00:00Z', result: {status: 'incorrect', sourceChecked: true, provisional: false}},
      {id: 'late-proposal', attemptId: 'older', supersedesId: 'late-correction', createdAt: '2026-12-06T12:00:00Z', result: {status: 'correct', sourceChecked: true, provisional: true}},
    ];
    for (const judgments of [state.judgments, [...state.judgments].reverse()]) {
      expect(estimate({...state, judgments}).objectives.find(o => o.id === 'mtel56.obj.0002')).toMatchObject({status: 'missed', missSignals: 1, remainingMinutes: 25});
    }
    state.judgments.push({id: 'checked-correction', attemptId: 'older', supersedesId: 'late-correction', createdAt: '2026-12-07T12:00:00Z', result: {status: 'correct', sourceChecked: true, provisional: false}});
    expect(estimate(state).objectives.find(o => o.id === 'mtel56.obj.0002')).toMatchObject({status: 'started', missSignals: 0});
  });

  it('only offers reviewed knowledge tasks outside the family cooldown', () => {
    const first = estimate().slices.find(s => s.track === 'knowledge')!;
    expect(first.taskId).toBeDefined();
    const task = catalog.tasks.find(t => t.id === first.taskId)!;
    expect(['mc', 'short', 'case']).toContain(task.kind);
    expect(['source_checked', 'human_reviewed']).toContain(task.reviewState);
    const state = empty();
    state.attempts = [attempt('just-now', task, now)];
    const next = estimate(state).slices.find(s => s.track === 'knowledge');
    if (next?.taskId) expect(catalog.tasks.find(t => t.id === next.taskId)!.familyId).not.toBe(task.familyId);
    expect(first.lessonId).toBeDefined();
    expect(first.label).toMatch(/Objective 000\d/);
  });
});

describe('five-part essay milestones', () => {
  it('budgets 150 minutes for five undrafted parts and selects the public-shape practice task', () => {
    const result = estimate();
    expect(result.essay.taskId).toBe(writing.id);
    expect(result.essay.parts).toHaveLength(5);
    expect(result.essayRemainingMinutes).toBe(150);
    expect(result.essayPercent).toBe(0);
    expect(result.essayRemainingMinutes).toBeGreaterThan(result.math.E);
    expect(result.essay.targetPartId).toBe(writing.parts![0].id);
    expect(result.essay.targetLabel).toContain('first draft');
  });

  it('gives drafted-only parts fifteen remaining minutes and one-third progress', () => {
    const result = estimate(drafted('An initial explanation'));
    expect(result.essayRemainingMinutes).toBe(75);
    expect(result.essayPercent).toBe(33);
    expect(result.essay.parts.every(p => p.drafted && !p.feedback && !p.revised && !p.evidence && p.remainingMinutes === 15)).toBe(true);
    expect(result.essay.targetLabel).toContain('preserve the response');
  });

  it('counts a changed submission after provisional feedback as revised but still needs text evidence', () => {
    const state = revised('A changed explanation after feedback');
    const before = structuredClone(state);
    const result = estimate(state);
    expect(result.essayRemainingMinutes).toBe(50);
    expect(result.essayPercent).toBe(67);
    expect(result.essay.parts.every(p => p.drafted && p.feedback && p.revised && !p.evidence && p.remainingMinutes === 10)).toBe(true);
    expect(result.essay.targetLabel).toContain('add mentor-text quotes');
    expect(state).toEqual(before);
  });

  it('finishes revised parts only when the latest part text quotes at least three bound mentor words', () => {
    const state = revised('The text says “A COMMUNITY   archive preserves records,” which supports this explanation.');
    const result = estimate(state);
    expect(result.essayRemainingMinutes).toBe(0);
    expect(result.essayPercent).toBe(100);
    expect(result.essay.parts.every(p => p.revised && p.evidence && p.remainingMinutes === 0)).toBe(true);
    expect(result.slices.find(s => s.track === 'knowledge')?.minutes).toBe(30);
    for (const text of ['The text says "community archive".', 'The text says "invented mentor text quotation".', 'A community archive preserves records.']) {
      expect(estimate(revised(text)).essay.parts.every(p => !p.evidence)).toBe(true);
    }
  });

  it('requires feedback before a different preserved response and ignores whitespace-only revisions', () => {
    const state = revised('  An   initial explanation  ');
    expect(estimate(state).essay.parts.some(p => p.revised)).toBe(false);
    state.attempts[1].originalAnswer = answer('A real change');
    state.judgments = [feedback('first', '2026-12-04T12:00:00Z')];
    expect(estimate(state).essay.parts.some(p => p.revised)).toBe(false);
    expect(estimate(state).essay.targetLabel).toContain('latest feedback');
  });

  it('uses the newest current-version draft for evidence and leaves archived drafts separate', () => {
    const state = revised('A revision using "a community archive preserves records".');
    state.drafts = [{taskId: writing.id, taskVersion: writing.version, updatedAt: '2026-12-04T12:00:00Z', answer: answer('Latest draft removed the quote')}];
    expect(estimate(state).essay.parts.some(p => p.evidence)).toBe(false);
    state.drafts[0].taskVersion = 'archived-version';
    expect(estimate(state).essay.parts.every(p => p.evidence)).toBe(true);
    expect(estimate({...empty(), drafts: state.drafts}).essayRemainingMinutes).toBe(150);
  });

  it('selects the writing task with the most recent current activity and targets parts in order', () => {
    const other = catalog.tasks.find(t => t.kind === 'writing' && t.id !== writing.id)!;
    const state = drafted('Draft started');
    state.attempts = [attempt('recent-other', other, '2026-12-05T12:00:00Z', {parts: {[other.parts![0].id]: 'A response'}})];
    expect(estimate(state).essay.taskId).toBe(other.id);
    const partState = empty();
    partState.attempts = [attempt('feedback-part', writing, '2026-12-01T12:00:00Z', {parts: {[writing.parts![1].id]: 'A second-part response'}})];
    partState.judgments = [feedback('feedback-part')];
    expect(estimate(partState).essay.targetPartId).toBe(writing.parts![1].id);
    partState.judgments = [];
    expect(estimate(partState).essay.targetPartId).toBe(writing.parts![0].id);
  });
});

describe('parallel sessions, flashcard catch-up and study days', () => {
  const tilt = {flashcards: 10, knowledge: 15, essay: 15};
  it('uses the documented parallel-session formula with completed-track reallocation', () => {
    // Two parallel sessions consume 30 knowledge/30 essay minutes; the remaining
    // 120 essay minutes use four 30-minute sessions: six sessions altogether.
    expect(remainingStudySessions(30, 150, 15, 15)).toBe(6);
    expect(remainingStudySessions(0, 150, 15, 15)).toBe(5);
    expect(remainingStudySessions(31, 0, 15, 15)).toBe(2);
    expect(remainingStudySessions(0, 0, 15, 15)).toBe(0);
    expect(remainingStudySessions(30, 30, 15, 15)).toBe(2);
  });

  it('reallocates empty tracks and zero-due flashcards while unknown flashcards keep maintenance', () => {
    expect(allocateStudySlices(tilt, 0, 150, 10)).toEqual({flashcards: 10, knowledge: 0, essay: 30});
    expect(allocateStudySlices(tilt, 0, 150, 0)).toEqual({flashcards: 0, knowledge: 0, essay: 40});
    expect(allocateStudySlices(tilt, 30, 0, 10)).toEqual({flashcards: 10, knowledge: 30, essay: 0});
    expect(allocateStudySlices(tilt, 30, 150, 0)).toEqual({flashcards: 0, knowledge: 15, essay: 25});
    expect(allocateStudySlices(tilt, 30, 30, 0)).toEqual({flashcards: 0, knowledge: 15, essay: 25});
    expect(allocateStudySlices(tilt, 30, 150, null)).toEqual(tilt);
    expect(allocateStudySlices(tilt, 0, 0, 0)).toEqual({flashcards: 0, knowledge: 40, essay: 0});
    expect(estimate(empty(), null).slices.find(s => s.track === 'flashcards')?.minutes).toBe(10);
    expect(estimate(empty(), null).flashcardCatchUpMinutes).toBe(0);
  });

  it('adds only flashcard backlog beyond the daily slice to knowledge minutes', () => {
    const result = estimate(empty(), cards(100));
    expect(result.flashcardCatchUpMinutes).toBe(40);
    expect(result.knowledgeRemainingMinutes).toBe(result.knowledgeObjectiveMinutes + 40);
    expect(estimate(empty(), cards(15)).flashcardCatchUpMinutes).toBe(0);
    expect(result.knowledgePercent).toBe(estimate(empty(), cards(15)).knowledgePercent);
    const uninitialized = {...cards(0), initialized: false, total: 0, new: 0};
    expect(estimate(empty(), uninitialized)).toMatchObject({dueCount: catalog.cards.length, totalCards: catalog.cards.length, deckNotStarted: true});
    expect(estimate(empty(), {...cards(), review: 4})).toMatchObject({stableCards: 4, totalCards: catalog.cards.length});
  });

  it('counts session N and about-total by distinct ET dates before today', () => {
    const task = catalog.tasks.find(t => t.kind === 'mc')!;
    const state = empty();
    state.attempts = [
      attempt('day-one', task, '2026-12-08T04:30:00Z'),
      attempt('day-two', task, '2026-12-08T05:30:00Z'),
      attempt('same-day', task, '2026-12-08T23:30:00Z'),
      attempt('today', task, now),
      attempt('future', task, '2026-12-11T12:00:00Z'),
    ];
    const result = estimate(state);
    expect(result.completedStudyDays).toBe(2);
    expect(result.sessionNumber).toBe(3);
    expect(result.aboutTotal).toBe(2 + result.remainingSessions);
  });

  it('is deterministic, read-only, totals forty minutes and uses bounded planning language', () => {
    const state = revised('A revision with "a community archive preserves records".');
    const original = structuredClone({catalog, state});
    const first = estimate(state);
    expect(estimate({...state, attempts: [...state.attempts].reverse(), judgments: [...state.judgments].reverse()}, cards(), {...catalog, tasks: [...catalog.tasks].reverse()})).toEqual(first);
    expect({catalog, state}).toEqual(original);
    expect(first.slices).toHaveLength(2);
    expect(first.slices.reduce((sum, slice) => sum + slice.minutes, 0)).toBe(40);
    expect(first.planLine).toMatch(/^Today:/);
    expect([first.planLine, first.planningNote, ...first.slices.map(s => `${s.label} ${s.detail}`)].join(' ')).not.toMatch(/\b(pass|IQ|intelligence)\b/i);
    expect(first.planningNote).toBe('A planning estimate from your saved work, not a prediction of your exam result.');
  });
});
