/**
 * Read-only planning estimate: k = objective minutes + max(0, due * 0.5 - F),
 * e = sum of unfinished writing-part minutes. After reallocating empty slices,
 * t = floor(min(k / K, e / E)); sessions = t + ceil(longer-track remainder / (K + E)).
 * Empty tracks share K + E; both empty means maintenance. These are planning assumptions.
 */
import {getReadiness, RETEST_DELAY_MS, type Catalog, type Readiness} from './index.js';
import {deriveCoverage} from './coverage.js';
import {planSession, type PlannerState} from './planner.js';
import type {FlashcardSummary} from './native-fsrs.js';

export const STUDY_TIME_ZONE = 'America/New_York';
export const EXAM_DATE = '2027-01-16';
export const SESSION_MINUTES = 40;
export const MINUTES_PER_CARD = 0.5;
export const FOCUSED_STATEMENT_LIMIT = 4;
export const KNOWLEDGE_MINUTES = {stable: 0, started: 15, focusedUnseen: 15, broadUnseen: 25, perMiss: 10, maximumMissExtra: 20} as const;
export const ESSAY_MINUTES = {undrafted: 30, drafted: 15, revisedWithoutEvidence: 10, revisedWithEvidence: 0} as const;
export const TIME_TILTS = [
  {through: '2026-12-15', flashcards: 10, knowledge: 15, essay: 15},
  {through: '2027-01-01', flashcards: 10, knowledge: 10, essay: 20},
  {through: EXAM_DATE, flashcards: 5, knowledge: 10, essay: 25},
] as const;
export const PLANNING_NOTE = 'A planning estimate from your saved work, not a prediction of your exam result.';

export type StudyTilt = {flashcards: number; knowledge: number; essay: number};
export type ObjectiveStatus = 'stable' | 'missed' | 'started' | 'unseen';
export type ObjectiveEstimate = {
  id: string; status: ObjectiveStatus; statementCount: number; skillIds: string[]; taskIds: string[];
  remainingMinutes: number; baselineMinutes: number; missSignals: number;
  taskId?: string; lessonId?: string; lessonTitle?: string;
};
export type EssayPartEstimate = {
  id: string; title: string; number: number; drafted: boolean; feedback: boolean; revised: boolean;
  evidence: boolean; progress: number; remainingMinutes: number;
};
export type EssayEstimate = {taskId?: string; parts: EssayPartEstimate[]; targetPartId?: string; targetLabel: string};
export type StudySlice = {
  track: 'flashcards' | 'knowledge' | 'essay'; minutes: number; label: string; detail: string;
  taskId?: string; lessonId?: string; objectiveId?: string; partId?: string;
};
export type StudyEstimate = {
  asOf: string; today: string; examDatePassed: boolean; daysUntilExam: number;
  tilt: StudyTilt; slices: StudySlice[]; knowledgeRemainingMinutes: number; knowledgeObjectiveMinutes: number;
  essayRemainingMinutes: number; flashcardCatchUpMinutes: number; remainingSessions: number;
  completedStudyDays: number; sessionNumber?: number; aboutTotal?: number; knowledgePercent: number; essayPercent: number;
  objectivesStable: number; objectivesTotal: number; stableCards: number | null; totalCards: number | null;
  dueCount: number | null; deckNotStarted: boolean; objectives: ObjectiveEstimate[]; essay: EssayEstimate;
  planLine: string; planningNote: string; math: {k: number; e: number; K: number; E: number};
};

type Row = Record<string, unknown>;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const instant = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
const versionKey = (taskId: unknown, version: unknown) => `${String(taskId)}@${String(version)}`;
const partText = (answer: unknown, partId: string) => {
  const text = object(object(answer).parts)[partId];
  return typeof text === 'string' ? text : '';
};
const whitespace = (text: string) => text.replace(/\s+/gu, ' ').trim();

function planningClock(now: string | number): number {
  const clock = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(clock) || !Number.isFinite(new Date(clock).getTime())) throw new RangeError('A valid injected planning time is required.');
  return clock;
}

/** Calendar identity is always Eastern Time, regardless of the browser's zone. */
export function etDate(now: string | number): string {
  const parts = new Intl.DateTimeFormat('en-US', {timeZone: STUDY_TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit'}).formatToParts(planningClock(now));
  const value = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function timeTilt(now: string | number): StudyTilt {
  const today = etDate(now), tilt = TIME_TILTS.find(item => today <= item.through) ?? TIME_TILTS[2];
  return {flashcards: tilt.flashcards, knowledge: tilt.knowledge, essay: tilt.essay};
}

/** Matches planSession: only checked, nonprovisional, nonsuperseded judgments count. */
export function latestStudyAuthoritative(attemptId: unknown, judgments: Row[]): Row | undefined {
  const checked = judgments.filter(j => j.attemptId === attemptId && object(j.result).sourceChecked === true && object(j.result).provisional === false);
  const replaced = new Set(checked.map(j => j.supersedesId));
  return checked.filter(j => !replaced.has(j.id)).at(-1);
}

/** Same ordering and historical family enrichment used by the existing planner. */
export function normalizeStudyState(catalog: Catalog, state: PlannerState): PlannerState {
  const judgments = state.judgments.slice().sort((a, b) =>
    (instant(a.createdAt) || 0) - (instant(b.createdAt) || 0)
    || Number(object(a.result).status === 'incorrect') - Number(object(b.result).status === 'incorrect')
    || compare(String(a.id ?? ''), String(b.id ?? '')));
  const taskVersions = (state.taskVersions ?? []).slice().sort((a, b) => compare(versionKey(a.id, a.version), versionKey(b.id, b.version)));
  const tasks = catalog.tasks.slice().sort((a, b) => compare(versionKey(a.id, a.version), versionKey(b.id, b.version)));
  const snapshots = new Map([...taskVersions, ...tasks].map(task => [versionKey(task.id, task.version), task]));
  const attempts = state.attempts.map<Row>(attempt => ({...attempt, exposureGroupId: attempt.exposureGroupId ?? snapshots.get(versionKey(attempt.taskId, attempt.taskVersion))?.familyId})).sort((a, b) =>
    (instant(a.submittedAt) || 0) - (instant(b.submittedAt) || 0)
    || Number(object(latestStudyAuthoritative(a.id, judgments)?.result).status === 'incorrect') - Number(object(latestStudyAuthoritative(b.id, judgments)?.result).status === 'incorrect')
    || compare(String(a.id ?? ''), String(b.id ?? '')));
  return {...state, attempts, judgments, evidenceEvents: state.evidenceEvents.slice().sort((a, b) => compare(String(a.id ?? ''), String(b.id ?? ''))), taskVersions};
}

/** Classifies existing readiness/coverage projections; creates no evidence or mastery state. */
export function classifyObjective({readiness, statementEvidence, statementNeedsRecheck, hasAttempts, incorrectTasks, statementCount}: {
  readiness: Readiness['status'][]; statementEvidence: boolean; statementNeedsRecheck: boolean;
  hasAttempts: boolean; incorrectTasks: number; statementCount: number;
}): Pick<ObjectiveEstimate, 'status' | 'remainingMinutes' | 'baselineMinutes' | 'missSignals'> {
  const baselineMinutes = statementCount <= FOCUSED_STATEMENT_LIMIT ? KNOWLEDGE_MINUTES.focusedUnseen : KNOWLEDGE_MINUTES.broadUnseen;
  const recheck = statementNeedsRecheck || readiness.includes('needs_recheck');
  const stable = readiness.every(status => status === 'independent_evidence' || status === 'transfer_evidence') && statementEvidence && !recheck;
  const missSignals = Number(recheck) + incorrectTasks;
  const status: ObjectiveStatus = stable ? 'stable' : missSignals ? 'missed' : hasAttempts || statementEvidence ? 'started' : 'unseen';
  const remainingMinutes = status === 'stable' ? KNOWLEDGE_MINUTES.stable : status === 'started' ? KNOWLEDGE_MINUTES.started
    : status === 'unseen' ? baselineMinutes
    : (hasAttempts ? KNOWLEDGE_MINUTES.started : baselineMinutes) + Math.min(KNOWLEDGE_MINUTES.maximumMissExtra, missSignals * KNOWLEDGE_MINUTES.perMiss);
  return {status, remainingMinutes, baselineMinutes, missSignals};
}

export function compareObjectiveNeed(a: ObjectiveEstimate, b: ObjectiveEstimate): number {
  const order = {missed: 0, started: 1, unseen: 2, stable: 3};
  return order[a.status] - order[b.status] || (a.status === 'missed' ? b.missSignals - a.missSignals : 0) || compare(a.id, b.id);
}

/** Literal quote matching is only a writing-work milestone, never a rubric judgment. */
export function normalizeMentorText(text: string): string {
  return whitespace(text.toLowerCase().replace(/[“”]/gu, '"')).replace(/^[\p{P}\s]+|[\p{P}\s]+$/gu, '');
}

export function hasMentorQuote(text: string, mentorText: string): boolean {
  const mentor = normalizeMentorText(mentorText);
  for (const match of text.matchAll(/["“]([^"“”]+)["”]/gu)) {
    const quote = normalizeMentorText(match[1]);
    if (quote.split(/\s+/u).filter(word => /[\p{L}\p{N}]/u.test(word)).length >= 3 && mentor.includes(quote)) return true;
  }
  return false;
}

export function estimateEssay(catalog: Catalog, state: PlannerState): EssayEstimate {
  const tasks = catalog.tasks.filter(task => task.kind === 'writing').slice().sort((a, b) => compare(a.id, b.id));
  const currentDraft = (task: Catalog['tasks'][number]) => (state.drafts ?? [])
    .filter(draft => draft.taskId === task.id && String(draft.taskVersion) === String(task.version))
    .slice().sort((a, b) => (instant(a.updatedAt) || 0) - (instant(b.updatedAt) || 0) || compare(JSON.stringify(a.answer) ?? '', JSON.stringify(b.answer) ?? '')).at(-1);
  const activity = (task: Catalog['tasks'][number]) => Math.max(instant(currentDraft(task)?.updatedAt) || 0,
    ...state.attempts.filter(attempt => attempt.taskId === task.id).map(attempt => instant(attempt.submittedAt) || 0));
  const active = tasks.filter(task => activity(task) > 0).sort((a, b) => activity(b) - activity(a) || compare(a.id, b.id))[0];
  const task = active ?? tasks.find(item => item.id === 'task.writing.mentor.community-archive') ?? tasks[0];
  if (!task) return {parts: [], targetLabel: 'review the written-response scaffold'};
  const draft = currentDraft(task);
  const attempts = state.attempts.filter(attempt => attempt.taskId === task.id).slice().sort((a, b) => (instant(a.submittedAt) || 0) - (instant(b.submittedAt) || 0) || compare(String(a.id), String(b.id)));
  const latestAttempt = attempts.at(-1);
  // A saved draft at the same instant is the current working text. Empty current text cannot inherit an old quote.
  const latestAnswer = draft && (instant(draft.updatedAt) || 0) >= (instant(latestAttempt?.submittedAt) || 0) ? draft.answer : latestAttempt?.originalAnswer;
  const mentor = catalog.mentorTexts.find(item => item.id === task.mentorTextId);
  const binding = object(latestAnswer);
  const mentorMatches = !!mentor && (binding.mentorTextId === undefined || binding.mentorTextId === mentor.id)
    && (binding.mentorTextVersion === undefined || String(binding.mentorTextVersion) === String(mentor.version))
    && (binding.mentorTextHash === undefined || binding.mentorTextHash === mentor.sha256);
  const parts = (task.parts ?? []).map<EssayPartEstimate>((part, index) => {
    const written = attempts.filter(attempt => partText(attempt.originalAnswer, part.id).trim().length > 0);
    const judgments = state.judgments.filter(judgment => written.some(attempt => attempt.id === judgment.attemptId));
    const drafted = partText(draft?.answer, part.id).trim().length > 0 || written.length > 0;
    const revised = judgments.some(judgment => {
      const earlier = written.find(attempt => attempt.id === judgment.attemptId)!;
      return written.some(later => instant(later.submittedAt) > instant(judgment.createdAt)
        && instant(later.submittedAt) > instant(earlier.submittedAt)
        && whitespace(partText(later.originalAnswer, part.id)) !== whitespace(partText(earlier.originalAnswer, part.id)));
    });
    const evidence = mentorMatches && hasMentorQuote(partText(latestAnswer, part.id), mentor!.text);
    const remainingMinutes = !drafted ? ESSAY_MINUTES.undrafted : !revised ? ESSAY_MINUTES.drafted
      : !evidence ? ESSAY_MINUTES.revisedWithoutEvidence : ESSAY_MINUTES.revisedWithEvidence;
    return {id: part.id, title: part.title, number: index + 1, drafted, feedback: judgments.length > 0, revised, evidence,
      progress: (Number(drafted) + Number(revised) + Number(evidence)) / 3, remainingMinutes};
  });
  const feedbackPart = parts.find(part => part.feedback && !part.revised);
  const undrafted = parts.find(part => !part.drafted);
  const needsFeedback = parts.find(part => part.drafted && !part.feedback);
  const needsEvidence = parts.find(part => part.revised && !part.evidence);
  const target = feedbackPart ?? undrafted ?? needsFeedback ?? needsEvidence;
  const named = target ? `Part ${target.number} (${target.title})` : '';
  const targetLabel = feedbackPart ? `rewrite ${named} from the latest feedback, adding a quote from the mentor text`
    : undrafted ? `first draft of ${named} with quotes from the mentor text`
    : needsFeedback ? `finish ${named} and preserve the response to get feedback`
    : needsEvidence ? `add mentor-text quotes to ${named}` : 'light review of your written response';
  return {taskId: task.id, parts, targetPartId: target?.id, targetLabel};
}

/** Unknown card counts keep maintenance; known zero redistributes to the larger work/slice ratio. */
export function allocateStudySlices(tilt: StudyTilt, k: number, e: number, dueCount: number | null): StudyTilt {
  const result = {...tilt};
  if (dueCount === 0) {
    if (k / result.knowledge > e / result.essay) result.knowledge += result.flashcards;
    else result.essay += result.flashcards;
    result.flashcards = 0;
  }
  if (k === 0 && e === 0) return {...result, knowledge: result.knowledge + result.essay, essay: 0};
  if (k === 0) { result.essay += result.knowledge; result.knowledge = 0; }
  if (e === 0) { result.knowledge += result.essay; result.essay = 0; }
  return result;
}

/** Both tracks advance together, then the unfinished track receives their combined slice. */
export function remainingStudySessions(k: number, e: number, K: number, E: number): number {
  if (k === 0 && e === 0) return 0;
  if (K + E <= 0 || (k > 0 && e > 0 && (K <= 0 || E <= 0))) throw new RangeError('Unfinished tracks need positive study slices.');
  if (k === 0) return Math.ceil(e / (K + E));
  if (e === 0) return Math.ceil(k / (K + E));
  const t = Math.floor(Math.min(k / K, e / E));
  const r = k / K > e / E ? k - t * K : e - t * E;
  return r <= 0 ? Math.max(Math.ceil(k / K), Math.ceil(e / E)) : t + Math.ceil(r / (K + E));
}

export function estimateStudyPlan({catalog, state, flashcards, now}: {catalog: Catalog; state: PlannerState; flashcards: FlashcardSummary | null; now: string | number}): StudyEstimate {
  const clock = planningClock(now), today = etDate(clock), tilt = timeTilt(clock);
  const normalized = normalizeStudyState(catalog, state), coverage = deriveCoverage(catalog, normalized);
  const tasks = catalog.tasks.slice().sort((a, b) => compare(versionKey(a.id, a.version), versionKey(b.id, b.version)));
  const readiness = new Map(catalog.skills.map(skill => [skill.id, getReadiness(skill.id, {...catalog, tasks}, normalized.attempts, normalized.judgments, normalized.evidenceEvents, normalized.taskVersions)]));
  const recommendations = planSession({catalog, state: normalized, now: clock}).recommendations;
  const reviewed = (task: Catalog['tasks'][number]) => ['source_checked', 'human_reviewed'].includes(task.reviewState);
  const available = (task: Catalog['tasks'][number]) => reviewed(task) && task.kind !== 'writing'
    && task.sourceRefs.length > 0 && task.sourceRefs.every(id => catalog.sources.some(source => source.id === id && ['source_compared', 'human_reviewed'].includes(source.reviewState)))
    && !task.skillIds.some(id => catalog.skills.find(skill => skill.id === id)?.status === 'retired')
    && !normalized.attempts.some(attempt => (attempt.taskId === task.id || attempt.exposureGroupId === task.familyId)
      && (!Number.isFinite(instant(attempt.submittedAt)) || clock < instant(attempt.submittedAt) + RETEST_DELAY_MS));
  const objectives = catalog.objectives.filter(objective => /^mtel56\.obj\.00(?:0[1-9]|1[0-2])$/u.test(objective.id)).slice().sort((a, b) => compare(a.id, b.id)).map<ObjectiveEstimate>(objective => {
    const number = objective.id.slice(-4), statements = coverage.statements.filter(statement => statement.objectiveId === objective.id);
    const statementIds = new Set(statements.map(statement => statement.statementId));
    const skillIds = [...new Set(catalog.alignments.filter(alignment => statementIds.has(alignment.statementId)).map(alignment => alignment.skillId))].sort(compare);
    const lesson = catalog.lessons.filter(item => item.id.includes(`obj${number}`)).slice().sort((a, b) => compare(a.id, b.id))[0];
    const ownTasks = tasks.filter(task => reviewed(task) && task.kind !== 'writing' && ((lesson && task.lessonId === lesson.id)
      || statements.some(statement => statement.reviewedPractice.some(binding => binding.taskId === task.id && String(binding.taskVersion) === String(task.version)))));
    const ownAttempts = normalized.attempts.filter(attempt => ownTasks.some(task => task.id === attempt.taskId));
    const incorrectTasks = ownTasks.filter(task => {
      const effective = new Set(ownAttempts.filter(attempt => attempt.taskId === task.id).map(attempt => latestStudyAuthoritative(attempt.id, normalized.judgments)?.id));
      const latest = normalized.judgments.filter(judgment => effective.has(judgment.id)).at(-1);
      return object(latest?.result).status === 'incorrect';
    }).length;
    const classification = classifyObjective({readiness: skillIds.map(id => readiness.get(id)?.status ?? 'unseen'),
      statementEvidence: statements.some(statement => statement.independentEvidence.length > 0), statementNeedsRecheck: statements.some(statement => statement.needsRecheck),
      hasAttempts: ownAttempts.length > 0, incorrectTasks, statementCount: statements.filter(statement => statement.kind === 'descriptive_bullet').length});
    const eligibleTasks = ownTasks.filter(available);
    const next = eligibleTasks.find(task => recommendations.some(recommendation => recommendation.kind === 'task' && recommendation.taskId === task.id)) ?? eligibleTasks[0];
    return {id: objective.id, ...classification, statementCount: statements.filter(statement => statement.kind === 'descriptive_bullet').length,
      skillIds, taskIds: ownTasks.map(task => task.id), taskId: next?.id, lessonId: lesson?.id, lessonTitle: lesson?.title};
  });
  const target = objectives.filter(objective => objective.status !== 'stable').sort(compareObjectiveNeed)[0];
  const essay = estimateEssay(catalog, normalized);
  const deckNotStarted = flashcards?.initialized === false;
  const dueCount = flashcards === null ? null : deckNotStarted ? catalog.cards.length : flashcards.due;
  const flashcardCatchUpMinutes = dueCount === null ? 0 : Math.max(0, dueCount * MINUTES_PER_CARD - tilt.flashcards);
  const knowledgeObjectiveMinutes = objectives.reduce((total, objective) => total + objective.remainingMinutes, 0);
  const k = knowledgeObjectiveMinutes + flashcardCatchUpMinutes, e = essay.parts.reduce((total, part) => total + part.remainingMinutes, 0);
  const allocated = allocateStudySlices(tilt, k, e, dueCount), K = allocated.knowledge, E = allocated.essay;
  const remainingSessions = remainingStudySessions(k, e, K, E);
  const completedStudyDays = new Set(normalized.attempts.filter(attempt => Number.isFinite(instant(attempt.submittedAt))).map(attempt => etDate(String(attempt.submittedAt))).filter(date => date < today)).size;
  const baseline = objectives.reduce((total, objective) => total + objective.baselineMinutes, 0);
  const knowledgePercent = baseline === 0 ? 0 : Math.max(0, Math.min(100, Math.round(100 * (1 - knowledgeObjectiveMinutes / baseline))));
  const essayPercent = essay.parts.length === 0 ? 0 : Math.round(100 * essay.parts.reduce((total, part) => total + part.progress, 0) / essay.parts.length);
  const objectiveName = target ? `Objective ${target.id.slice(-4)}${target.lessonTitle ? ` — ${target.lessonTitle}` : ''}` : '';
  const task = catalog.tasks.find(item => item.id === target?.taskId);
  const slices: StudySlice[] = [];
  if (allocated.flashcards > 0) slices.push({track: 'flashcards', minutes: allocated.flashcards, label: 'flashcards',
    detail: dueCount === null ? 'Flashcard count is unavailable; keep a maintenance slice.' : deckNotStarted ? `${dueCount} catalog cards; the deck has not been started.` : `${dueCount} cards due across the available deck.`});
  if (K > 0) slices.push({track: 'knowledge', minutes: K,
    label: target ? `${task ? 'checks' : 'lesson review'} for ${objectiveName}` : flashcardCatchUpMinutes > 0 ? 'flashcard catch-up and light knowledge review' : 'light knowledge review',
    detail: task ? task.title : target ? 'Review the objective lesson; its checks are currently unavailable or cooling down.' : 'Revisit a short lesson and maintain your saved learning.',
    objectiveId: target?.id, lessonId: target?.lessonId, taskId: target?.taskId});
  if (E > 0) slices.push({track: 'essay', minutes: E, label: essay.targetLabel, detail: 'Derived writing practice using the bound mentor text.', taskId: essay.taskId, partId: essay.targetPartId});
  return {asOf: new Date(clock).toISOString(), today, examDatePassed: today > EXAM_DATE,
    daysUntilExam: Math.max(0, Math.round((Date.parse(`${EXAM_DATE}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / RETEST_DELAY_MS)),
    tilt, slices, knowledgeRemainingMinutes: k, knowledgeObjectiveMinutes, essayRemainingMinutes: e, flashcardCatchUpMinutes, remainingSessions, completedStudyDays,
    ...(remainingSessions > 0 ? {sessionNumber: completedStudyDays + 1, aboutTotal: completedStudyDays + remainingSessions} : {}),
    knowledgePercent, essayPercent, objectivesStable: objectives.filter(objective => objective.status === 'stable').length, objectivesTotal: objectives.length,
    stableCards: flashcards === null ? null : flashcards.review, totalCards: flashcards === null ? null : deckNotStarted ? catalog.cards.length : flashcards.total,
    dueCount, deckNotStarted, objectives, essay, planLine: `Today: ${slices.map(slice => `${slice.minutes} min ${slice.label}`).join(', ')}.`, planningNote: PLANNING_NOTE, math: {k, e, K, E}};
}
