# Coverage contract and local session planning

This slice starts at `a2b2ee00a5521d00fbc77dd5ad3f82cca58f1f9c`. It adds derived coverage and recommendations to the existing React workspaces. It does not extend the curriculum, judge a learner response, or change SQLite, import rules, security controls, or immutable evidence policy v2.

## Coverage means bounded support, not completion

The source inventory and catalog retain their exact **13 objectives, 59 official descriptive bullets, and one distinct Objective 0013 integration referral**: 60 statement records. The 11 endorsement competencies, five teacher indicators, 23 alignment links, and prerequisite graph remain separate. Referral wording does not become a sixtieth descriptive bullet, and a writing task does not inherit coverage of objectives 0001–0012 through that referral.

`packages/shared/src/coverage-contract.ts` records a versioned, derived audit of existing content. Each binding identifies a statement and source version, specific task versions and evidence skills, a limited instructional scope, and a remaining gap. Unversioned lesson payloads have a nonsecurity fingerprint so changed wording invalidates an old coverage claim. These are model-assisted scope decisions, not official wording or human review.

There are nine explicit statement scopes: two in 0001, one in 0006, two in 0008, three in 0009, and the 0013 referral. Eight have partial lesson instruction; nine have scoped reviewed practice. All 60 statements and all 13 objectives retain gaps. The installed catalog has 29 source-checked tasks and zero human-reviewed tasks. No lesson, task, source, human review, or learner success was added.

`deriveCoverage` produces a record for every inventoried statement with independent fields for inventory, mapping, partial instruction, reviewed practice, scoped independent observations, pending judgments, historical observations, exclusions, and recheck needs. A broad skill alignment supplies only mapping. An available lesson is not proof it was read; an available task is not learner evidence. The standards map shows the counts and remaining gaps for all objectives, with exact statement/source identity and separate endorsement denominators.

Qualifying observations require an explicit task/version binding, active compared source support, an authoritative nonprovisional judgment, a matching eligible evidence event, and effective eligibility under the unchanged 24-hour policy. They support only the named partial scope. Provisional writing feedback remains pending. Failures, merged-history uncertainty, assistance, and feedback-dependent corrections remain visible. Archived observations are retained but do not establish current statement coverage after a binding changes. Existing skill readiness continues to interpret archived task snapshots under its own established rules; these are different questions, not interchangeable counts. No statement/objective mastery threshold is introduced, and an empty objective is never complete.

## Deterministic recommendations

`planSession({catalog, state, now})` is a pure projection. The caller injects an instant; the planner does not read a clock, mutate inputs, generate IDs, or persist events. Stable task identities and event ordering settle ties. A short queue contains one task or a truthful research/review gap for each of retrieval, application/transfer, and writing.

Reasons expose the relevant recheck signal, prior assistance, latest same-task/family feedback, earliest fresh start, current saved draft, archived versions, explicit statement scope, and judgment limitations. Source-checked is described as model-assisted/source-compared, not human validated. Retired/draft tasks and missing, unverified, or superseded sources cannot supply a reviewed recommendation. Missing family history blocks an independence claim. A pending judgment calls for review rather than an immediate corrective retry.

Fresh starts must reach the latest same-task/family response plus 24 hours. A task version change cannot reset that history. Waiting does not cleanse a held draft's early start or assistance. The planner prefers suitable independent opportunities over assisted drafts; opening a saved response preserves it. The existing explicit fresh-retest action remains the way to start blank work where available. A recommendation describes an opportunity, never a guaranteed eligible result or a successful observation. Application and writing require judgment and cannot automatically promote readiness.

`SessionPlan` rereads local `/state` after the desk mounts, following the existing draft-navigation save guard. A refresh button deliberately updates both history and the injected planning time. Reasons are ordinary accessible text; launch/override controls are native buttons and a labeled select. A launch selects the current existing task and moves focus into the workspace. It neither clears the draft nor calls a mutation endpoint. Writing supports the exact selected task through an optional initial task ID. Overrides remain available even when the queue contains only gaps.

There is no FSRS integration, Anki scheduling assertion, BKT, AI call, pass probability, automatic promotion, or new backend/storage migration.

## Remaining curriculum and next bounded wave

The eight lesson-backed scopes are partial; the referral has only two authored writing tasks and no comprehensive integration instruction. Most statements still lack any explicit lesson/task scope. In particular, current identification/placement details, exit thresholds, monitoring durations, accommodations, and the full 2026 programming guidance remain research gaps. ACCESS/MCAS administration/reporting, complete differentiation across proficiency/grade/literacy levels, culture/families, linguistic systems, acquisition theory, vocabulary/literacy, and the broader subject-area objectives need dedicated work. These are curriculum limits, not evidence that a learner failed.

The next bounded wave should compare the already inventoried official materials for Objective 0001's identification/placement scope, record precise source/version support and unresolved policy details, then draft a small set of explicitly scoped lessons and distinct-family checks for real human review. Do not invent thresholds or claim human validation. Writing adjudication remains a separate future workflow requiring a real human action.

## Validation in this sandbox

Node `22.17.1` and npm `10.9.2` were available. The worktree has no `node_modules`; provisioning was forbidden. No real runtime or private learner data was accessed.

| Check | Actual result |
| --- | --- |
| Required base SHA and branch | Matched required SHA on `athena/20261108-194036-8c3569` before edits |
| `npm run content:validate` | Blocked: `tsx` executable unavailable |
| `npm run typecheck` | Blocked: `tsc` executable unavailable |
| `npm run lint` | Blocked: `eslint` executable unavailable |
| `npm run build` | Blocked at its typecheck step: `tsc` unavailable |
| `npm test -- tests/coverage.test.ts tests/planner.test.ts` | Blocked: `vitest` executable unavailable; zero tests executed |
| `npm test -- tests/coverage.test.ts` | Same missing `vitest` blocker; zero tests executed |
| All unit/integration tests | Not executed: dependencies unavailable; six existing integration cases also write protected `runtime/` SQLite paths |
| `npm run test:e2e` | Not executed: dependencies unavailable; configured server writes protected `runtime/test-databases/e2e-*.sqlite`; a baseline test also writes a protected screenshot and synthetic marker |
| Read-only Node assertions against catalog and contract | Passed: inventory counts, binding statement/source versions, referenced task versions/skills, and lesson fingerprints |
| `node --experimental-strip-types --check` on the three new shared modules and two new pure test files | Passed syntax checks only; no typechecking or execution of test cases |
| `git diff --check` and final changed-path review | Passed; no changed protected paths or inventory/catalog files |
| `gitnexus detect_changes --scope all` | Blocked: unindexed worktree could not resolve a registered repository; reported multiple indexed repositories. No index/configuration changes made |

The 74 existing unit/integration cases and 12 browser regressions remain in place. Fifteen new coverage cases and 20 new planner cases bring the authored unit/integration total to 109; four added browser cases bring the browser total to 16. These counts are from source inspection, not test execution. They cover the contract, chronology, deterministic selection, no fake evidence on launch/override, held-draft refresh, and keyboard operation. Syntax checks and source inspection do not establish a passing TypeScript build or regression suite. Run the full prescribed checks on the independently authorized test box before relying on this slice.

GitNexus upstream requests for `App`, `Writing`, `StudyState`, and `mockDesk` found no corresponding symbols in the parent Projects index (risk UNKNOWN). The worktree itself is unindexed; no index/configuration was created. Local callers are the React entry point, existing workspaces, and browser fixtures. New pure modules are consumed only by the new UI and focused tests. The bridge owns the isolated commit; no manual staging or commit is part of this task.

## Changed files and entry points

| Files | Change |
| --- | --- |
| `packages/shared/src/coverage-contract.ts`, `coverage.ts` | New `SOURCE_COVERAGE_CONTRACT`, `lessonFingerprint`, and `deriveCoverage` |
| `packages/shared/src/planner.ts` | New `planSession` and typed recommendation/state contract |
| `apps/web/src/Standards.tsx`, `SessionPlan.tsx` | New standards and recommendation components using existing visual styles |
| `apps/web/src/App.tsx` | Wires components and guarded task launch; existing `main.tsx` remains its caller |
| `apps/web/src/Writing.tsx`, `types.ts` | Optional initial writing task; typed saved-draft projection on `StudyState` |
| `tests/coverage.test.ts`, `tests/planner.test.ts`, `apps/web/e2e.spec.ts` | Focused pure/browser regressions; browser mock exposes drafts and records API mutations |
| `README.md`, `docs/architecture.md`, this document | Behavior, scope, curriculum limits, and actual validation record |
