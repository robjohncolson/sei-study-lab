# SEI Study Lab — confirmed review fixes

Work locally in the existing `sei-study-lab` project on Athena. Do not commit, push, deploy, install system software/browser binaries, download models, touch classroom repositories, read secrets, or send private answers anywhere. Preserve existing learner data. Back up any real database with the supported SQLite backup mechanism before migrations. Do not reset a database or update/delete append-only history. Use isolated synthetic databases for tests.

The uploaded source snapshot passed content validation, typecheck, lint, all 31 unit/integration tests, and production build on Node 24.22.1. Four existing Edge browser tests were not independently rerun. These tests currently miss the confirmed issues below. Investigate each reproduction and fix the behavior; the locations are entry points, not instructions to implement a particular patch.

## 1. High: feedback-trained revisions are counted as independent evidence

Locations: `apps/web/src/Practice.tsx:21-23`; `apps/server/src/store.ts:86-90,95-109`; `packages/shared/src/index.ts:45-57`.

Reproduction using the real catalog and an isolated SeiStore:
1. Submit `task.survey-purpose@1`, answer `a`, hintCount 0. Corrective feedback is returned/displayed.
2. Immediately submit answer `b`, hintCount 0, parentAttemptId equal to the first attempt ID.
3. The second attempt has assistance [], and its evidence is eligible:true, independence:`unaided`, despite the just-seen correction.
4. Combining this corrected revision with a correct `task.translation-preference` attempt at least 24 hours later promotes `sei.skill.identification` to `independent_evidence`.

Expected: immediate revisions following feedback remain valuable learning practice, not fresh independent observations. Derive feedback exposure/revision dependence conservatively on the server; do not rely only on a client hint counter. Define a transparent policy for when a genuinely delayed, independently administered retest becomes eligible. Merely adding a parent ID must not permanently disqualify every future retest, but an immediate correction must not qualify. Preserve original attempts/judgments/events; fix interpretation using versioned/append-only correction mechanisms or authoritative derived eligibility, not destructive rewrites.

Regression tests: wrong->immediate right revision is ineligible; right->immediate edited response is not an independent observation; correction cannot clear a recheck/promote readiness through an old delayed pair; explicitly delayed fresh retests under the documented policy can qualify; historical feedback-trained revisions do not retain misleading independent status after upgrade. Keep family deduplication and hint/assistance exclusion.

## 2. Medium: navigation can discard the latest unsaved answer

Locations: `apps/web/src/Practice.tsx:19-20`; `apps/web/src/Writing.tsx:15-16`; navigation/task selection in `apps/web/src/App.tsx:22` and the practice/writing selectors.

Confirmed from effect cleanup: autosave waits 900 ms, and cleanup cancels the timer without flushing or retaining the pending answer. Type a character and switch task/text/workspace before 900 ms: that edit is not persisted. A fast switch away can therefore lose prose despite the app's recovery claims.

Expected: navigation either awaits/retains the latest pending draft, or presents a reliable unsaved-work warning. Do not send stale responses to the newly selected task; handle in-flight saves and errors. Keep data local. Avoid relying solely on an asynchronous unmount request as a durability guarantee.

Regression tests: type then navigate immediately (<900 ms) in both practice and writing, return/reload and recover exact latest text; switching rapidly between two tasks does not cross-write drafts; failed saves clearly block/warn rather than claim success. Cover accessibility/keyboard navigation. Browser tests must run only with an available approved browser; report any unrun tests honestly.

## 3. Medium: updating a task version silently erases its history from readiness

Locations: `packages/shared/src/index.ts:42-44`; `apps/server/src/store.ts:65,68-70,112`; `apps/web/src/App.tsx:24,29-30`.

Reproduction: create an isolated DB using catalog task `task.survey-purpose@1`, save one correct attempt, close it. Reopen the same DB with a catalog in which only that task's version/prompt becomes v2. The v1 task and attempt remain intact in SQLite, but getReadiness uses only current catalog.tasks, so the skill becomes `unseen` and explanation says `No attempts yet`. A prior failure can likewise disappear from the readiness interpretation.

Expected: readiness resolves historical task versions from immutable stored snapshots. If content changes invalidate evidence, display an explicit version-change/recheck explanation, retaining historical observations and exclusions; never say an attempted skill was never attempted. Do not automatically equate different task versions as independent item families. Export/import and restored DBs must agree.

Regression tests: v1 success and failure remain visible after v2 activation; source/task retirement is explicitly explained; old evidence cannot silently disappear or become fresh evidence; unchanged catalog preserves current results. Use immutable version lookups, not mutable cached readiness.

## 4. Medium: old task-version drafts are silently reused under a changed prompt

Locations: `apps/server/src/store.ts:113-114`; `apps/web/src/Practice.tsx:18`; `apps/web/src/Writing.tsx:14`.

Reproduction: save a draft for `task.survey-purpose@1`, then reopen the DB with current task v2 and a changed prompt. GET draft still returns taskVersion `1`, but Practice ignores taskVersion and recovers its answer into the v2 editor. The next save overwrites that draft as v2 and the next submission attributes the old text to v2. Writing also does not compare taskVersion; checking mentor ID/hash alone does not cover a changed prompt with the same mentor text.

Expected: retain draft version identity; surface an old-version draft separately and require deliberate copying/migration into a changed task. Preserve the old draft or a recoverable archive rather than silently replacing it. Task version must be checked in both editors, including same-text writing revisions. Preserve exact mentor text and rubric identity.

Regression tests: v1 draft is not auto-resubmitted as v2; user can recover/copy it deliberately; changed writing prompts with unchanged mentor text are detected; routine reload of unchanged versions still restores answers and support metadata.

## Completion and boundaries

Keep existing Host/Origin/CSRF checks, safe React rendering, transactional/idempotent imports, quote verification, original-answer immutability, provisional proposal semantics, loopback binding, TSV-only Anki and disabled model adapters. Do not add cloud services, BKT, or inference to solve these fixes. Keep the honest curriculum gap labels: 13 objectives are inventoried, not comprehensively taught; human content review and current operational policy coverage remain outstanding.

Run content validation, typecheck, lint, unit/integration tests and build; run browser tests when available. Add focused regression tests for all four issues and report actual counts/results and unrun checks. Update README/data-schema/implementation-status documentation where behavior changes, including the independent-retest policy and draft-version recovery workflow. Provide a concise local diff/review summary and safe restart instructions. Nothing should be committed, pushed, deployed, or sent externally.
