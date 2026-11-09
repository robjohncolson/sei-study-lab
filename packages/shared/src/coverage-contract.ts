/** Derived audit of the installed starter content, not official wording or human review.
 * Every binding samples only the named scope. No binding asserts complete instruction.
 * Lessons have no version field, so their payload fingerprint also invalidates stale links.
 */
export type CoverageBinding = {
  statementId: string;
  statementVersion: string | number;
  sourceVersionId: string;
  sourceVersion: string | number;
  scope: string;
  remainingGap: string;
  lessons: {lessonId: string; fingerprint: string}[];
  tasks: {taskId: string; taskVersion: string | number; skillId: string}[];
};

export const INTEGRATION_REFERRAL_ID = 'mtel56.obj.0013.reference.0001-0012';
export const COVERAGE_CONTRACT_VERSION = 1;
const sourceVersionId = 'source.framework.2026-11-08';
const lesson = (lessonId: string, fingerprint: string) => ({lessonId, fingerprint});
const tasks = (skillId: string, ids: string[]): CoverageBinding['tasks'] =>
  ids.map(taskId => ({taskId: `task.${taskId}`, taskVersion: 1, skillId: `sei.skill.${skillId}`}));
const binding = (statementId: string, scope: string, remainingGap: string, lessons: CoverageBinding['lessons'], taskRefs: CoverageBinding['tasks']): CoverageBinding =>
  ({statementId, statementVersion: 1, sourceVersionId, sourceVersion: '2026-11-08', scope, remainingGap, lessons, tasks: taskRefs});

export const SOURCE_COVERAGE_CONTRACT: readonly CoverageBinding[] = [
  binding('mtel56.obj.0001.ds.01',
    'Shared classroom responsibility and communicating content/language observations to colleagues.',
    'These short examples do not establish comprehensive implementation across educator roles and settings.',
    [lesson('lesson.shared', '10ec0e2e')],
    tasks('shared-responsibility', ['shared-plan', 'team-evidence', 'shared-recall', 'case-new-student'])),
  binding('mtel56.obj.0001.ds.03',
    'Survey versus proficiency, family communication preferences, and evidence-responsive support for current/former ELs; recognizing the need to verify policy.',
    'Complete identification/placement procedures, current exit thresholds, monitoring durations, accommodations, and detailed 2026 programming guidance remain research gaps.',
    [lesson('lesson.identification', '8c09a860'), lesson('lesson.current-former', 'd550f631')],
    [...tasks('identification', ['survey-purpose', 'translation-preference', 'survey-recall', 'case-new-student']),
      ...tasks('current-former', ['former-support', 'policy-date', 'policy-recall', 'case-former-el'])]),
  binding('mtel56.obj.0006.ds.01',
    'Oral rehearsal as one bridge into written explanations.',
    'The wider role of listening comprehension and oral language across the curriculum is not fully instructed or assessed.',
    [lesson('lesson.academic', '84927e7a')],
    tasks('oral-to-writing', ['rehearsal-bridge', 'rehearsal-evidence', 'rehearsal-recall', 'case-water'])),
  binding('mtel56.obj.0008.ds.01',
    'Distinguishing conversational fluency from the academic language needed for mathematical explanation.',
    'Differentiation across grade, proficiency, and literacy levels remains broader than these examples.',
    [lesson('lesson.academic', '84927e7a')],
    tasks('academic-language', ['social-academic', 'academic-recall'])),
  binding('mtel56.obj.0008.ds.05',
    'Connected explanations, modeled language, and oral rehearsal into writing in mathematics/science examples.',
    'The range of academic-language methods, vocabulary instruction, and participation in classroom discourse remains incomplete.',
    [lesson('lesson.academic', '84927e7a')],
    [...tasks('academic-language', ['language-levels']), ...tasks('oral-to-writing', ['rehearsal-bridge', 'rehearsal-evidence', 'rehearsal-recall', 'case-water'])]),
  binding('mtel56.obj.0009.ds.03',
    'Formative use of classroom evidence and separating content reasoning from English control.',
    'Assessment types, portfolios, grading practices, performance assessment, and proficiency-specific interpretation are only partially represented.',
    [lesson('lesson.assessment', 'a764cb9e')],
    tasks('assessment-purpose', ['grammar-content', 'formative-use', 'formative-recall', 'case-former-el'])),
  binding('mtel56.obj.0009.ds.04',
    'Interpreting uneven language-domain profiles instead of assuming equal strengths from one overall result.',
    'ACCESS/MCAS purposes, reporting, administration, and interpretation require dedicated source-backed instruction; domain recall alone does not test these.',
    [lesson('lesson.assessment', 'a764cb9e')],
    tasks('domain-profiles', ['uneven-profile', 'domain-demand', 'domains-recall', 'case-water'])),
  binding('mtel56.obj.0009.ds.05',
    'Reducing classroom language barriers while preserving the content reasoning demanded by a task.',
    'Proficiency-specific assessment differentiation and current permitted standardized-test accommodations remain unsupported.',
    [lesson('lesson.scaffolding', 'b43d34f3')],
    tasks('rigorous-scaffolds', ['preserve-demand', 'fade-support', 'scaffold-recall', 'case-former-el'])),
  binding(INTEGRATION_REFERRAL_ID,
    'Two authored mentor-text tasks sample integrated lesson planning in five custom parts.',
    'This referral points to objectives 0001–0012. Two derived writing tasks neither cover all those statements nor supply official Parts II–V; authoritative writing adjudication remains unavailable.',
    [], tasks('integrated-writing', ['writing.mentor.math-plans', 'writing.mentor.science-streams'])),
];
