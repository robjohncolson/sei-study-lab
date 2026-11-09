import { getAttemptEligibility, getReadiness, RETEST_DELAY_MS, type Catalog, type EligibilityAttempt, type Readiness } from './index.js';
import { deriveCoverage } from './coverage.js';

export type PlannerTrack = 'RETRIEVAL' | 'APPLICATION_TRANSFER' | 'WRITING';
export type PlannerState = {
  attempts: Record<string, unknown>[];
  judgments: Record<string, unknown>[];
  evidenceEvents: Record<string, unknown>[];
  taskVersions?: Catalog['tasks'];
  drafts?: {taskId: string; taskVersion: string | number; answer: unknown; updatedAt?: string}[];
};
export type PlannerRecommendation = {
  track: PlannerTrack;
  kind: 'task' | 'gap';
  taskId?: string;
  taskVersion?: string | number;
  title: string;
  reasons: string[];
  startMode: 'fresh' | 'resume' | 'research';
  independence: 'potentially_independent' | 'assisted' | 'pending_review' | 'unavailable';
  availableAt?: string;
};
export type SessionPlan = {
  asOf: string;
  recommendations: PlannerRecommendation[];
  gaps: {statementId: string; objectiveId: string; reasons: string[]}[];
  limitations: string[];
};

type Row = Record<string, unknown>;
const tracks: PlannerTrack[] = ['RETRIEVAL', 'APPLICATION_TRANSFER', 'WRITING'];
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const id = (row: Row) => String(row.id ?? '');
const instant = (value: unknown) => typeof value === 'string' ? Date.parse(value) : NaN;
const object = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};
const versionKey = (taskId: unknown, version: unknown) => `${String(taskId)}@${String(version)}`;
const trackFor = (task: Catalog['tasks'][number]): PlannerTrack => task.kind === 'writing' ? 'WRITING' : task.kind === 'case' ? 'APPLICATION_TRANSFER' : 'RETRIEVAL';
const hasAssistance = (row: Row) => Number(row.hintCount ?? 0) > 0 || (Array.isArray(row.assistance) && row.assistance.length > 0);

function latestAuthoritative(attemptId: unknown, judgments: Row[]): Row | undefined {
  const checked = judgments.filter(j => j.attemptId === attemptId && object(j.result).sourceChecked === true && object(j.result).provisional === false);
  const replaced = new Set(checked.map(j => j.supersedesId));
  return checked.filter(j => !replaced.has(j.id)).at(-1);
}

/** Read-only planning heuristic. `now` is the sole clock; no timers, storage, randomness or promotions. */
export function planSession({catalog, state, now}: {catalog: Catalog; state: PlannerState; now: string | number}): SessionPlan {
  const clock = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(clock) || !Number.isFinite(new Date(clock).getTime())) throw new RangeError('A valid injected planning time is required.');
  const asOf = new Date(clock).toISOString();
  // Stable ordering also removes incidental import-order ties in the legacy readiness reader.
  // A simultaneous authoritative failure sorts last; uncertainty is never resolved as success.
  const judgments = state.judgments.slice().sort((a, b) => {
    const date = (instant(a.createdAt) || 0) - (instant(b.createdAt) || 0);
    return date || Number(object(a.result).status === 'incorrect') - Number(object(b.result).status === 'incorrect') || compare(id(a), id(b));
  });
  const historicalTasks = (state.taskVersions ?? []).slice().sort((a, b) => compare(versionKey(a.id, a.version), versionKey(b.id, b.version)));
  const tasks = catalog.tasks.slice().sort((a, b) => compare(versionKey(a.id, a.version), versionKey(b.id, b.version)));
  const snapshots = new Map([...historicalTasks, ...tasks].map(t => [versionKey(t.id, t.version), t]));
  const attempts = state.attempts.map<Row>(a => ({...a, exposureGroupId: a.exposureGroupId ?? snapshots.get(versionKey(a.taskId, a.taskVersion))?.familyId})).sort((a, b) => {
    const date = (instant(a.submittedAt) || 0) - (instant(b.submittedAt) || 0);
    return date || Number(object(latestAuthoritative(a.id, judgments)?.result).status === 'incorrect') - Number(object(latestAuthoritative(b.id, judgments)?.result).status === 'incorrect') || compare(id(a), id(b));
  });
  const evidenceEvents = state.evidenceEvents.slice().sort((a, b) => compare(id(a), id(b)));
  const normalized = {...state, attempts, judgments, evidenceEvents, taskVersions: historicalTasks};
  const coverage = deriveCoverage(catalog, normalized);
  const gaps = coverage.statements.filter(s => s.gaps.length > 0).map(s => ({statementId: s.statementId, objectiveId: s.objectiveId, reasons: s.gaps.slice().sort(compare)})).sort((a, b) => compare(a.statementId, b.statementId));
  const readiness = new Map<string, Readiness>();
  for (const skill of catalog.skills.slice().sort((a, b) => compare(a.id, b.id))) {
    readiness.set(skill.id, getReadiness(skill.id, {...catalog, tasks}, attempts, judgments, evidenceEvents, historicalTasks));
  }
  const sources = new Map(catalog.sources.map(s => [s.id, s]));
  const candidates: {recommendation: PlannerRecommendation; rank: number[]}[] = [];
  const blocked = new Map<PlannerTrack, {cooldowns: number[]; pending: number; unavailable: number; uncertain: number}>(tracks.map(track => [track, {cooldowns: [], pending: 0, unavailable: 0, uncertain: 0}]));

  for (const task of tasks) {
    const track = trackFor(task), issues = blocked.get(track)!;
    const sourceReady = task.sourceRefs.length > 0 && task.sourceRefs.every(ref => ['source_compared', 'human_reviewed'].includes(sources.get(ref)?.reviewState ?? ''));
    if (!['source_checked', 'human_reviewed'].includes(task.reviewState) || !sourceReady || task.skillIds.some(skillId => catalog.skills.find(s => s.id === skillId)?.status === 'retired')) {
      issues.unavailable++; continue;
    }
    const family = attempts.filter(a => a.taskId === task.id || a.exposureGroupId === task.familyId);
    const own = family.filter(a => a.taskId === task.id);
    // Missing snapshots with an unidentifiable family cannot safely supply an independent slot.
    const unknownFamily = attempts.some(a => !a.exposureGroupId && !snapshots.has(versionKey(a.taskId, a.taskVersion)));
    if (unknownFamily || family.some(a => !Number.isFinite(instant(a.submittedAt)))) { issues.uncertain++; continue; }
    const latest = family.length ? Math.max(...family.map(a => instant(a.submittedAt))) : undefined;
    const available = latest === undefined ? undefined : latest + RETEST_DELAY_MS;
    const pending = own.filter(a => !['correct', 'incorrect'].includes(String(object(latestAuthoritative(a.id, judgments)?.result).status))).length;
    // An unresolved response needs adjudication, not another automatic corrective retry.
    if (pending) issues.pending += pending;
    const cooling = available !== undefined && clock < available;
    if (cooling) issues.cooldowns.push(available);
    if (pending || cooling) continue;
    const draftOrder = (d: NonNullable<PlannerState['drafts']>[number]) => {
      const metadata = object(d.answer);
      return [d.updatedAt ?? '', String(metadata.startedAt ?? ''), String(metadata.hintCount ?? ''), String(Array.isArray(metadata.assistance) ? metadata.assistance.length : 0), String(metadata.parentAttemptId ?? '')].join('|');
    };
    const drafts = (state.drafts ?? []).filter(d => d.taskId === task.id && String(d.taskVersion) === String(task.version)).slice().sort((a, b) => compare(draftOrder(a), draftOrder(b)));
    const saved = drafts.at(-1), draft = object(saved?.answer);
    const started = instant(draft.startedAt);
    const missingParent = !!draft.parentAttemptId && !attempts.some(a => a.id === draft.parentAttemptId && a.taskId === task.id);
    const held = !!saved && (hasAssistance(draft) || missingParent || !Number.isFinite(started) || started > clock || (available !== undefined && started < available));
    const historicalSourceGap = attempts.some(a => {
      const snapshot = snapshots.get(versionKey(a.taskId, a.taskVersion));
      return snapshot?.skillIds.some(skillId => task.skillIds.includes(skillId)) && (!snapshot.sourceRefs.length || snapshot.sourceRefs.some(ref => !['source_compared', 'human_reviewed'].includes(sources.get(ref)?.reviewState ?? '')));
    });
    const needsRecheck = historicalSourceGap || task.skillIds.some(skillId => readiness.get(skillId)?.status === 'needs_recheck');
    const priorAssistance = family.some(hasAssistance);
    const familyHasSuccess = family.some(a => {
      const judgment = latestAuthoritative(a.id, judgments);
      const snapshot = snapshots.get(versionKey(a.taskId, a.taskVersion));
      const reviewed = snapshot && ['source_checked', 'human_reviewed'].includes(snapshot.reviewState) && snapshot.sourceRefs.length > 0 && snapshot.sourceRefs.every(ref => ['source_compared', 'human_reviewed'].includes(sources.get(ref)?.reviewState ?? ''));
      return reviewed && object(judgment?.result).status === 'correct' && evidenceEvents.some(e => e.attemptId === a.id && e.judgmentId === judgment?.id && e.eligible === true && task.skillIds.includes(String(e.skillId))) && getAttemptEligibility(a as EligibilityAttempt, attempts as EligibilityAttempt[]).eligible;
    });
    const familyFailure = needsRecheck && family.some(a => {
      const judgment = latestAuthoritative(a.id, judgments);
      return object(judgment?.result).status === 'incorrect' && evidenceEvents.some(e => e.attemptId === a.id && e.judgmentId === judgment?.id && e.eligible === true);
    });
    const bound = coverage.statements.filter(s => s.reviewedPractice.some(p => p.taskId === task.id && String(p.taskVersion) === String(task.version))).sort((a, b) => compare(a.statementId, b.statementId));
    const missingEvidence = bound.filter(s => s.independentEvidence.length === 0).length;
    const independent = track === 'RETRIEVAL' && !!task.answerKey && !held;
    const reasons: string[] = [];
    if (needsRecheck) {
      if (historicalSourceGap) reasons.push('Needs recheck: a historical task references missing, unverified or superseded source support. Older observations remain recorded and do not settle the current source gap.');
      for (const skillId of [...task.skillIds].sort(compare)) {
        const status = readiness.get(skillId);
        if (status?.status === 'needs_recheck') reasons.push(`Needs recheck: ${catalog.skills.find(s => s.id === skillId)?.title ?? skillId}. ${status.explanation}`);
      }
    }
    if (available !== undefined) reasons.push(`The latest same-task or item-family response was ${new Date(latest!).toISOString()}; a fresh start can qualify from ${new Date(available).toISOString()} (24-hour feedback cooldown).`);
    else reasons.push('No recorded same-task or item-family response starts a feedback cooldown for this task.');
    if (priorAssistance) reasons.push(familyHasSuccess ? 'Earlier work in this item family used hints or assistance and stays assisted, even though later independent work is also recorded.' : 'Earlier work in this item family used hints or assistance. A new unaided response is needed; earlier work stays assisted.');
    reasons.push(familyHasSuccess ? 'This item family already has a qualifying success in the recorded history; an available family without one normally takes priority unless a recheck is needed.' : 'This item family has no qualifying independent success in the supplied history. A fresh unaided check can address that evidence gap without repeating an already successful family.');
    if (saved) {
      reasons.push(held ? 'A held draft retains its original start time and assistance; waiting does not make it independent. Opening resumes that draft as assisted or uncertain practice.' : 'Opening resumes a saved draft with its original start time. Eligibility still depends on recorded assistance and the server checks at submission.');
      if (held && track === 'RETRIEVAL' && own.length) reasons.push('To seek independent evidence, deliberately choose the existing Start fresh retest action in practice and answer unaided after the cooldown.');
      if (missingParent) reasons.push('The draft references a missing revision parent or one attached to another task; independence cannot be established from the available history.');
    } else reasons.push('Open the current task to start a new response; no current-version draft is recorded.');
    if ((state.drafts ?? []).some(d => d.taskId === task.id && String(d.taskVersion) !== String(task.version))) reasons.push('An archived-version draft remains separate. Copying it into the current task records assistance.');
    if (own.some(a => String(a.taskVersion) !== String(task.version))) reasons.push('Archived task-version history is retained. A version change does not reset the same-task or family cooldown.');
    if (bound.length) reasons.push(`Explicit partial practice scope: ${bound.map(s => s.statementId).join(', ')}. ${missingEvidence} scoped statement(s) lack independent observations; this task does not establish whole-statement coverage.`);
    else reasons.push('This reviewed task has no current explicit statement-level practice binding. Broad skill alignment is not proof that a statement was taught or tested.');
    reasons.push(task.reviewState === 'source_checked' ? 'Source-checked means model-assisted/source-compared, not human validated.' : 'The catalog records human review of this task; that does not judge a new learner response.');
    if (track !== 'RETRIEVAL' || !task.answerKey) reasons.push('Open-response work requires judgment. Application/transfer or writing practice remains pending and cannot automatically promote readiness.');
    else reasons.push('Potential independence describes a start opportunity only. Submission still requires an unaided response, a checked judgment, and the existing evidence policy; no success or mastery is presumed.');
    const recommendation: PlannerRecommendation = {
      track, kind: 'task', taskId: task.id, taskVersion: task.version, title: task.title, reasons,
      startMode: saved ? 'resume' : 'fresh',
      independence: held ? 'assisted' : independent ? 'potentially_independent' : 'pending_review',
      ...(available === undefined ? {} : {availableAt: new Date(available).toISOString()}),
    };
    // Lexicographic priorities, not probabilities: eligible work, rechecks, unresolved
    // assistance, family diversity, scoped gaps, delayed fresh work, stable identity.
    candidates.push({recommendation, rank: [held ? 2 : independent ? 0 : 1, needsRecheck ? 0 : 1, familyFailure ? 0 : 1, priorAssistance && !familyHasSuccess ? 0 : 1, familyHasSuccess ? 1 : 0, missingEvidence ? 0 : 1, available !== undefined && !saved && !familyHasSuccess ? 0 : 1, saved ? 1 : 0, own.length]});
  }

  const recommendations = tracks.map(track => {
    const choices = candidates.filter(c => c.recommendation.track === track).sort((a, b) => {
      for (let n = 0; n < a.rank.length; n++) { if (a.rank[n] !== b.rank[n]) return a.rank[n] - b.rank[n]; }
      return compare(versionKey(a.recommendation.taskId, a.recommendation.taskVersion), versionKey(b.recommendation.taskId, b.recommendation.taskVersion));
    });
    if (choices.length) return choices[0].recommendation;
    const issues = blocked.get(track)!;
    const earliest = issues.cooldowns.length ? Math.min(...issues.cooldowns) : undefined;
    const reasons = ['No suitable reviewed task is available for this track now. Use the standards map to choose a documented gap for source research; no task or evidence has been invented.'];
    if (issues.pending) reasons.push(`${issues.pending} response(s) need an authoritative judgment. Provisional feedback remains pending; repeating a response cannot supply that review.`);
    if (earliest !== undefined) reasons.push(`Same-family feedback blocks ${issues.cooldowns.length} task(s). Earliest possible fresh start: ${new Date(earliest).toISOString()}. A held draft will still retain its old start and assistance.`);
    if (issues.unavailable) reasons.push(`${issues.unavailable} task(s) are draft/retired or lack active compared source support. Historical work stays recorded.`);
    if (issues.uncertain) reasons.push('Missing task-family snapshots or invalid feedback times prevent a safe independence recommendation; resolve the history/source gap first.');
    return {track, kind: 'gap' as const, title: issues.pending ? 'Review pending judgments and curriculum gaps' : 'Research an uncovered standard', reasons, startMode: 'research' as const, independence: 'unavailable' as const, ...(earliest === undefined ? {} : {availableAt: new Date(earliest).toISOString()})};
  });
  return {asOf, recommendations, gaps, limitations: [
    'This short queue is a deterministic educational heuristic, not a pass prediction, mastery promotion, or spaced-repetition algorithm.',
    'Retrieval, application/transfer, and writing are separate tracks. Open-response recommendations do not establish transfer evidence or an authoritative writing judgment.',
    'Recommendations read saved local history. Opening or overriding one creates no attempt, judgment, or evidence event; only the existing explicit submission flow records a response.',
    'Coverage is partial and source/version bound. Source comparison is not human validation; current legal specifics and unsupported curriculum remain research gaps.',
  ]};
}
