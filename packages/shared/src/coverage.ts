import {getAttemptEligibility, type Catalog} from './index.js';
import {COVERAGE_CONTRACT_VERSION, INTEGRATION_REFERRAL_ID, SOURCE_COVERAGE_CONTRACT, type CoverageBinding} from './coverage-contract.js';

/** Read-only event projections; original answers are never inspected or changed. */
export type CoverageState = {
  attempts: readonly any[];
  judgments: readonly any[];
  evidenceEvents: readonly any[];
  taskVersions?: Catalog['tasks'];
};
export type StatementCoverage = {
  statementId: string; objectiveId: string; version: string | number;
  sourceVersionId: string; sourceVersion: string | number | null; sourceState: string;
  text: string; kind: 'descriptive_bullet' | 'integration_referral'; inventory: true;
  mappedSkillIds: string[];
  partialInstruction: {lessonId: string; scope: string}[];
  reviewedPractice: {taskId: string; taskVersion: string | number; reviewState: string; scope: string}[];
  independentEvidence: {attemptId: string; taskId: string; taskVersion: string | number; scope: string; historical: false}[];
  pendingJudgments: string[];
  historicalObservations: string[];
  exclusions: {attemptId: string; reason: string}[];
  needsRecheck: boolean; gaps: string[]; complete: false;
};
export type CoverageCounts = {
  statementCount: number; bulletCount: number; referralCount: number;
  mappedStatementCount: number; partialInstructionCount: number; reviewedPracticeCount: number;
  independentEvidenceCount: number; pendingJudgmentCount: number; gapCount: number;
};
export type ObjectiveCoverage = CoverageCounts & {objectiveId: string; complete: false; gaps: string[]};
export type CoverageReport = {
  contractVersion: number; statements: StatementCoverage[]; objectives: ObjectiveCoverage[];
  totals: CoverageCounts & {objectiveCount: number; sourceCheckedTaskCount: number; humanReviewedTaskCount: number};
  limitations: string[];
};

const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const unique = (values: string[]) => [...new Set(values)].sort(order);
const checkedSource = (catalog: Catalog, id: string) => catalog.sources.some(s => s.id === id && ['source_compared', 'human_reviewed'].includes(s.reviewState));
const checkedTask = (catalog: Catalog, task: Catalog['tasks'][number]) =>
  ['source_checked', 'human_reviewed'].includes(task.reviewState) && task.sourceRefs.length > 0 && task.sourceRefs.every(id => checkedSource(catalog, id));

/** Nonsecurity change detector for unversioned derived lessons, not a source hash. */
export function lessonFingerprint(lesson: Catalog['lessons'][number]): string {
  const text = JSON.stringify([lesson.title, lesson.body, [...lesson.skillIds].sort(order), [...lesson.sourceRefs].sort(order)]);
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function counts(rows: StatementCoverage[]): CoverageCounts {
  return {
    statementCount: rows.length,
    bulletCount: rows.filter(s => s.kind === 'descriptive_bullet').length,
    referralCount: rows.filter(s => s.kind === 'integration_referral').length,
    mappedStatementCount: rows.filter(s => s.mappedSkillIds.length > 0).length,
    partialInstructionCount: rows.filter(s => s.partialInstruction.length > 0).length,
    reviewedPracticeCount: rows.filter(s => s.reviewedPractice.length > 0).length,
    independentEvidenceCount: rows.filter(s => s.independentEvidence.length > 0).length,
    pendingJudgmentCount: rows.filter(s => s.pendingJudgments.length > 0).length,
    gapCount: rows.filter(s => s.gaps.length > 0).length,
  };
}

/**
 * Derive coverage without promoting mastery or treating skill alignment as a content audit.
 * Each independent observation supports only an explicit task/statement scope. A newer task
 * version needs a new binding; historical observations remain visible, never silently relabeled.
 */
export function deriveCoverage(catalog: Catalog, state: CoverageState = {attempts: [], judgments: [], evidenceEvents: []}, contract: readonly CoverageBinding[] = SOURCE_COVERAGE_CONTRACT): CoverageReport {
  const currentTasks = new Map(catalog.tasks.map(t => [t.id, t]));
  const snapshots = new Map([...(state.taskVersions ?? []), ...catalog.tasks].map(t => [`${t.id}@${t.version}`, t]));
  const attempts = state.attempts.map(a => ({...a, exposureGroupId: a.exposureGroupId ?? snapshots.get(`${a.taskId}@${a.taskVersion}`)?.familyId}))
    .sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt) || order(String(a.id), String(b.id)));
  const statements: StatementCoverage[] = [...catalog.statements].sort((a, b) => order(a.id, b.id)).map(statement => {
    const source = catalog.sources.find(s => s.id === statement.sourceVersionId);
    const row: StatementCoverage = {
      statementId: statement.id, objectiveId: statement.objectiveId, version: statement.version,
      sourceVersionId: statement.sourceVersionId, sourceVersion: source?.version ?? null, sourceState: source?.reviewState ?? 'missing',
      text: statement.text, kind: statement.id === INTEGRATION_REFERRAL_ID ? 'integration_referral' : 'descriptive_bullet', inventory: true,
      mappedSkillIds: unique(catalog.alignments.filter(a => a.statementId === statement.id).map(a => a.skillId)),
      partialInstruction: [], reviewedPractice: [], independentEvidence: [], pendingJudgments: [], historicalObservations: [], exclusions: [],
      needsRecheck: false, gaps: [], complete: false,
    };
    const bindings = contract.filter(b => b.statementId === statement.id);
    const validBindings = bindings.filter(b => String(b.statementVersion) === String(statement.version)
      && b.sourceVersionId === statement.sourceVersionId && String(b.sourceVersion) === String(source?.version)
      && checkedSource(catalog, statement.sourceVersionId));
    if (!checkedSource(catalog, statement.sourceVersionId)) {
      row.gaps.push('The inventoried source is missing, unverified, or superseded; current coverage cannot be established.');
      row.needsRecheck = bindings.length > 0;
    }
    if (bindings.length && validBindings.length !== bindings.length) {
      row.gaps.push('The statement/source version does not match the derived coverage contract; its bindings require recheck.');
      row.needsRecheck = true;
    }
    for (const b of validBindings) {
      row.gaps.push(b.remainingGap);
      for (const ref of b.lessons) {
        const lesson = catalog.lessons.find(l => l.id === ref.lessonId);
        if (lesson && lessonFingerprint(lesson) === ref.fingerprint && lesson.sourceRefs.length > 0 && lesson.sourceRefs.every(id => checkedSource(catalog, id))) {
          row.partialInstruction.push({lessonId: ref.lessonId, scope: b.scope});
        } else {
          row.gaps.push(`Lesson ${ref.lessonId} is missing, changed, or supported by an unavailable source; its partial instruction needs recheck.`);
          row.needsRecheck = true;
        }
      }
      for (const ref of b.tasks) {
        const task = currentTasks.get(ref.taskId);
        if (task && String(task.version) === String(ref.taskVersion) && checkedTask(catalog, task) && task.skillIds.includes(ref.skillId)) {
          row.reviewedPractice.push({taskId: task.id, taskVersion: task.version, reviewState: task.reviewState, scope: b.scope});
        } else {
          row.gaps.push(`Task ${ref.taskId}@${ref.taskVersion} is unavailable, changed, retired, or lacks checked sources; no current practice credit is inferred.`);
          row.needsRecheck = true;
        }
      }
    }
    const observed = attempts.filter(a => bindings.some(b => b.tasks.some(t => t.taskId === a.taskId)));
    const failures: number[] = [], successes: number[] = [];
    const effectiveResults: {time: number; correct: boolean}[] = [];
    for (const a of observed) {
      const snapshot = snapshots.get(`${a.taskId}@${a.taskVersion}`), current = currentTasks.get(a.taskId);
      const b = validBindings.find(binding => binding.tasks.some(t => t.taskId === a.taskId && String(t.taskVersion) === String(a.taskVersion)));
      const ref = b?.tasks.find(t => t.taskId === a.taskId && String(t.taskVersion) === String(a.taskVersion));
      const active = !!snapshot && !!current && !!b && !!ref && String(current.version) === String(a.taskVersion)
        && row.reviewedPractice.some(t => t.taskId === a.taskId && String(t.taskVersion) === String(a.taskVersion));
      if (!active) {
        row.historicalObservations.push(String(a.id));
        row.needsRecheck = true;
        row.exclusions.push({attemptId: String(a.id), reason: 'Original task/statement/source binding is archived, unavailable, or no longer current; history is retained without current statement evidence credit.'});
      }
      // Provisional proposals cannot supersede an authoritative observation.
      const checked = state.judgments.filter(j => j.attemptId === a.id && j.result?.sourceChecked === true && j.result?.provisional === false);
      const superseded = new Set(checked.map(j => j.supersedesId).filter(Boolean));
      const j = checked.filter(j => !superseded.has(j.id)).sort((x, y) =>
        Date.parse(x.createdAt ?? a.submittedAt) - Date.parse(y.createdAt ?? a.submittedAt)
        || Number(x.result?.status === 'incorrect') - Number(y.result?.status === 'incorrect')
        || order(String(x.id), String(y.id))).at(-1);
      if (!j || !['correct', 'incorrect'].includes(j.result?.status)) {
        row.pendingJudgments.push(String(a.id));
        continue;
      }
      if (!active || !snapshot || !b || !ref) continue;
      const event = state.evidenceEvents.find(e => e.attemptId === a.id && e.judgmentId === j.id && e.skillId === ref.skillId && e.eligible === true);
      const policy = getAttemptEligibility(a, attempts);
      if (!policy.eligible || !event) {
        row.exclusions.push({attemptId: String(a.id), reason: policy.reason ?? 'No authoritative eligible event for this explicit task/statement scope.'});
        if (event && j.result.status === 'incorrect') failures.push(Date.parse(a.submittedAt));
        continue;
      }
      const time = Date.parse(a.submittedAt), correct = j.result.status === 'correct';
      effectiveResults.push({time, correct});
      if (correct) {
        successes.push(time);
        row.independentEvidence.push({attemptId: String(a.id), taskId: snapshot.id, taskVersion: snapshot.version, scope: b.scope, historical: false});
      } else failures.push(time);
    }
    const latest = Math.max(...effectiveResults.map(r => r.time));
    if (effectiveResults.some(r => r.time === latest && !r.correct) || failures.some(time => !successes.some(success => success > time))) row.needsRecheck = true;
    if (!row.partialInstruction.length) row.gaps.push('No explicitly bounded current lesson instruction is documented for this statement.');
    if (!row.reviewedPractice.length) row.gaps.push('No explicitly bounded reviewed current task is documented for this statement. Broad skill links do not establish tested coverage.');
    if (!row.independentEvidence.length) row.gaps.push('No independent successful observation for an explicitly bound current task scope.');
    if (row.pendingJudgments.length) row.gaps.push('One or more submitted responses still need an authoritative judgment; provisional feedback is not independent evidence.');
    if (row.needsRecheck) row.gaps.push('Recheck remains necessary: a failure, merged-history uncertainty, or historical binding cannot be cleared by assisted corrections.');
    row.gaps = unique(row.gaps);
    row.pendingJudgments = unique(row.pendingJudgments);
    row.historicalObservations = unique(row.historicalObservations);
    row.partialInstruction.sort((a, b) => order(a.lessonId, b.lessonId));
    row.reviewedPractice.sort((a, b) => order(a.taskId, b.taskId));
    return row;
  });
  const objectives = [...catalog.objectives].sort((a, b) => order(a.id, b.id)).map(o => {
    const rows = statements.filter(s => s.objectiveId === o.id);
    return {objectiveId: o.id, ...counts(rows), complete: false as const,
      gaps: rows.length ? [`${rows.filter(s => s.gaps.length).length} of ${rows.length} statement records retain gaps; scoped observations are not objective mastery.`] : ['No statement inventory is present; an empty objective is never complete.']};
  });
  return {
    contractVersion: COVERAGE_CONTRACT_VERSION, statements, objectives,
    totals: {...counts(statements), objectiveCount: objectives.length,
      sourceCheckedTaskCount: catalog.tasks.filter(t => t.reviewState === 'source_checked' && checkedTask(catalog, t)).length,
      humanReviewedTaskCount: catalog.tasks.filter(t => t.reviewState === 'human_reviewed' && checkedTask(catalog, t)).length},
    limitations: [
      'Coverage is a derived, model-assisted audit of explicit starter-content scopes, not human validation or a claim of comprehensive instruction.',
      'Source-checked tasks are model-assisted/source-compared. Their review label does not establish human review.',
      'Counts use official descriptive bullets and the distinct objective 0013 integration referral separately. The endorsement competency/indicator crosswalk has separate denominators.',
      'A lesson being available is not proof it was read. A reviewed task being available is not successful learner evidence.',
      'Independent observations support only the named scope; no statement or objective mastery threshold is defined, and no empty objective is complete.',
    ],
  };
}
