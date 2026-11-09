import { getAttemptEligibility, type Catalog } from '../../../packages/shared/src/index.js';
import { SubmitSchema, type Attempt, type Evidence, type Judgment, type Json } from './types.js';

export class StudyValidationError extends Error {}

type Task = Catalog['tasks'][number];
export type StudySnapshot = { catalog: Catalog; taskVersions: Task[]; attempts: Attempt[] };
export type StudyDraft = { taskVersion: string; answer: Json; updatedAt: string };
export type StudyDraftState = StudyDraft & { taskId: string };

/** Current tasks come from the bundle; an explicit version always uses its immutable snapshot. */
export function lookupTask(catalog: Catalog, taskVersions: Task[], id: string, version?: string | number): Task {
  const task = version === undefined ? catalog.tasks.find(item => item.id === id) :
    taskVersions.find(item => item.id === id && String(item.version) === String(version));
  if (!task) throw new StudyValidationError('Unknown task or immutable task version');
  return task;
}

/** Validation and construction are pure: adapters supply the timestamp, identity and history. */
export function prepareStudyAttempt(raw: unknown, sessionId: string, snapshot: StudySnapshot, now: string, id: string): Attempt {
  const body = SubmitSchema.parse(raw);
  const { catalog, taskVersions, attempts } = snapshot;
  const task = lookupTask(catalog, taskVersions, body.taskId, body.taskVersion);
  if (String(lookupTask(catalog, taskVersions, body.taskId).version) !== String(body.taskVersion) || task.reviewState === 'retired') {
    throw new StudyValidationError('Task version changed or retired. Recover your draft and review the active prompt before submitting.');
  }
  if (task.kind === 'mc' && typeof body.answer === 'string' && !task.options?.some(option => option.id === body.answer) && body.answer !== "I don't know") {
    throw new StudyValidationError('Choose one of the authored options');
  }
  if (body.startedAt && Date.parse(body.startedAt) > Date.parse(now)) throw new StudyValidationError('Start time cannot be in the future');
  if (body.parentAttemptId) {
    const parent = attempts.find(attempt => attempt.id === body.parentAttemptId);
    if (!parent || parent.taskId !== task.id) throw new StudyValidationError('Revision must reference an attempt on this task');
  }
  const mentor = catalog.mentorTexts.find(item => item.id === task.mentorTextId);
  if (task.kind === 'writing') {
    const answer = body.answer as Record<string, Json>;
    if (!answer || typeof answer !== 'object' || Array.isArray(answer) || !mentor || answer.mentorTextId !== mentor.id || String(answer.mentorTextVersion) !== String(mentor.version) || answer.mentorTextHash !== mentor.sha256) {
      throw new StudyValidationError('Writing answer must retain the exact mentor text identity');
    }
    validateWritingAnswer(task, body.answer, mentor);
  }
  return { id, taskId: task.id, taskVersion: task.version, sessionId, originalAnswer: body.answer,
    startedAt: body.startedAt ?? now, submittedAt: now, hintCount: body.hintCount, assistance: body.assistance,
    exposureGroupId: task.familyId, noveltyKind: task.noveltyKind, parentAttemptId: body.parentAttemptId ?? null,
    mentorText: mentor ? { id: mentor.id, version: mentor.version, sha256: mentor.sha256 } : null };
}

const normalize = (text: string) => text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
export function scoreStudyAttempt(task: Task, attempt: Attempt, sources: Catalog['sources'], id: string): Judgment {
  const key = task.answerKey;
  const answer = typeof attempt.originalAnswer === 'string' ? attempt.originalAnswer : null;
  let status: Judgment['result']['status'] = 'needs_review';
  let feedback = 'Saved for review. An open response needs evidence-based human judgment; missing keywords alone do not make it wrong.';
  if (answer !== null && normalize(answer) === "i don't know") {
    status = 'incorrect'; feedback = key?.feedback ?? 'Use the lesson to build an explanation, then return for a new attempt.';
  } else if (key && answer !== null && ['mc', 'short'].includes(task.kind)) {
    if (key.accepted.some(value => normalize(value) === normalize(answer))) { status = 'correct'; feedback = key.feedback; }
    else if (task.kind === 'mc') { status = 'incorrect'; feedback = key.wrongFeedback[answer] ?? key.feedback; }
    else feedback = `This wording is not in the bounded answer key, so it remains unscored. Compare your reasoning with: ${key.feedback}`;
  }
  const checked = ['source_checked', 'human_reviewed'].includes(task.reviewState) && task.sourceRefs.length > 0 && task.sourceRefs.every(sourceId => {
    const source = sources.find(item => item.id === sourceId);
    return source && ['source_compared', 'human_reviewed'].includes(source.reviewState);
  });
  return { id, attemptId: attempt.id, judgeKind: 'authored_key', judgeVersion: 'bounded-key-v1',
    rubricVersionId: task.rubricVersionId ?? null, result: { status, feedback, provisional: status === 'needs_review', sourceChecked: checked },
    quotedEvidence: answer && status !== 'needs_review' ? [answer] : [],
    uncertaintyReason: status === 'needs_review' ? 'Unmatched or open response requires review' : null,
    supersedesId: null, createdAt: attempt.submittedAt };
}

export function deriveStudyEvidence(task: Task, attempt: Attempt, judgment: Judgment, allAttempts: Attempt[], ids: string[], policyVersion: 1 | 2 = 2): Evidence[] {
  if (ids.length !== task.skillIds.length) throw new Error('An evidence identity is required for every task skill');
  const context = allAttempts.filter(item => item.id !== attempt.id && (item.taskId === attempt.taskId || item.exposureGroupId === attempt.exposureGroupId) && Date.parse(item.submittedAt) <= Date.parse(attempt.submittedAt));
  const policy = policyVersion === 2 ? getAttemptEligibility(attempt, context) :
    { eligible: attempt.hintCount === 0 && attempt.assistance.length === 0, reason: 'Hints or assistance recorded' };
  const unaided = policy.eligible;
  const eligible = unaided && judgment.result.sourceChecked && !judgment.result.provisional && judgment.result.status !== 'needs_review';
  return task.skillIds.map((skillId, index) => ({ id: ids[index], attemptId: attempt.id, judgmentId: judgment.id, skillId,
    evidenceKind: judgment.result.status === 'correct' ? 'success' : judgment.result.status === 'incorrect' ? 'failure' : 'pending',
    independence: unaided ? 'unaided' : 'assisted', eligible,
    exclusionReason: eligible ? null : !unaided ? policy.reason : !judgment.result.sourceChecked ? 'Task or source has not been source checked' : 'Judgment awaits review',
    createdAt: judgment.createdAt, familyId: task.familyId, noveltyKind: attempt.noveltyKind, sourceChecked: judgment.result.sourceChecked, hintCount: attempt.hintCount,
    ...(policyVersion === 2 ? { eligibilityPolicyVersion: 2 as const, eligibilityContextAttemptIds: context.map(item => item.id).sort() } : {}) }));
}

export function validateWritingAnswer(task: Task, answer: Json, mentor: Catalog['mentorTexts'][number], draft = false) {
  if (!answer || typeof answer !== 'object' || Array.isArray(answer) || answer.mentorTextId !== mentor.id || String(answer.mentorTextVersion) !== String(mentor.version) || answer.mentorTextHash !== mentor.sha256) throw new StudyValidationError('Writing answer must retain the exact mentor text identity');
  if ((draft || answer.rubricVersionId !== undefined) && answer.rubricVersionId !== task.rubricVersionId) throw new StudyValidationError('Writing rubric version mismatch');
  const parts = answer.parts;
  if (!parts || typeof parts !== 'object' || Array.isArray(parts) || (!draft && (Object.keys(parts).length !== 5 || task.parts?.some(part => typeof parts[part.id] !== 'string'))) || Object.entries(parts).some(([id, value]) => typeof value !== 'string' || !task.parts?.some(part => part.id === id))) throw new StudyValidationError('Keep all five derived parts attached to the same mentor text');
}

export function validateStudyDraft(catalog: Catalog, taskId: string, taskVersion: string | number, answer: Json): Task {
  const task = lookupTask(catalog, [], taskId);
  if (String(task.version) !== String(taskVersion) || task.reviewState === 'retired') throw new StudyValidationError('Draft task version changed or retired. Preserve the old draft and deliberately copy it into the current prompt.');
  if (task.kind === 'writing') {
    const mentor = catalog.mentorTexts.find(item => item.id === task.mentorTextId);
    if (!mentor) throw new StudyValidationError('Writing mentor text is unavailable');
    validateWritingAnswer(task, answer, mentor, true);
  }
  return task;
}

/** Adapters provide drafts newest first, retaining every archived version. */
export function shapeStudyDraft(task: Task, rows: StudyDraft[]) {
  const current = rows.find(row => row.taskVersion === String(task.version));
  return { ...(current ?? { answer: null, taskVersion: String(task.version) }), currentTaskVersion: String(task.version),
    olderDrafts: rows.filter(row => row.taskVersion !== String(task.version)) };
}

export function shapeStudyState(data: { attempts: Attempt[]; judgments: Judgment[]; evidenceEvents: Evidence[]; taskVersions: Task[]; drafts: StudyDraftState[] }) {
  return { ...data, anki: { mode: 'tsv', reviewsSynchronized: false, message: 'reviews not synchronized' }, models: { enabled: false, calls: 0 } };
}
