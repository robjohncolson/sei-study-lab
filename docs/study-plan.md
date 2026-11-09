# Your 40-minute study plan

The study desk projects a plan from the existing saved attempts, judgments, evidence events, task versions, writing drafts and native flashcard queue. It extends `planSession`, `getReadiness` and `deriveCoverage`; it does not store another learning model or change evidence. Opening or refreshing the desk reads `/api/state` and `/api/native-flashcards` in parallel. It never initializes a deck, submits a response, requests feedback or writes a judgment.

The planning note is: **A planning estimate from your saved work, not a prediction of your exam result.**

## Calendar and daily slices

All calendar dates use `Intl.DateTimeFormat` with `America/New_York`. The injected `now` is the only clock. The exam planning date is 16 January 2027. Calendar days remaining are clamped to zero, and dates after the target set `examDatePassed` while retaining the final tilt.

| Eastern date | Flashcards (F) | Knowledge (K) | Essay (E) |
| --- | ---: | ---: | ---: |
| Through 15 December 2026 | 10 | 15 | 15 |
| 16 December 2026 through 1 January 2027 | 10 | 10 | 20 |
| From 2 January 2027 | 5 | 10 | 25 |

The slices always total 40 minutes. If the known due count is zero, the flashcard slice moves to the track with the larger remaining-minutes/current-slice ratio; ties go to essay. Unknown flashcard counts retain a maintenance slice. A finished track gives its slice to the unfinished track. If both tracks are finished, the plan keeps flashcard maintenance when needed or unknown and assigns the rest to light review.

## Knowledge estimate

Objectives 0001 through 0012 use their actual catalog lesson titles. Objective 0013 belongs to the written-response track. Objective skills come only from statement-to-skill alignments. Objective tasks are reviewed non-writing tasks attached to the objective lesson, together with the current reviewed-practice bindings supplied by coverage. Descriptive statements determine whether an unseen objective is focused (four or fewer) or broad.

The estimator normalizes event ordering and historical task-family identities in the same way as `planSession`, then reads the existing readiness and coverage projections. An objective is **stable** when every mapped skill has independent or transfer evidence, at least one objective statement has an independent observation, and neither statements nor mapped skills need rechecking. Some catalog objectives have no mapped skills; their skill condition adds no requirement, but the independent statement observation and absence of recheck signals are still required. This is a planning label for the available partial practice, not a new evidence record or a claim of comprehensive objective coverage.

An objective is **missed** if it is not stable and a mapped skill or statement needs a recheck, or an own task's latest authoritative judgment is incorrect. **Started** means an own-task attempt or statement independent observation exists; otherwise it is **unseen**. Only checked, nonprovisional, nonsuperseded judgments supply correctness. For each task, the newest effective authoritative judgment across its attempts supplies its recent miss signal. A late correction to an older attempt can therefore be the latest task judgment. Simultaneous judgments use the planner's deterministic ordering, with an incorrect result last.

| Planning status | Remaining minutes |
| --- | ---: |
| Stable | 0 |
| Started | 15 |
| Unseen, focused | 15 |
| Unseen, broad | 25 |
| Missed with attempts | 15 plus miss time |
| Missed without attempts | Unseen baseline plus miss time |

A recheck anywhere among mapped skills or statements contributes one combined miss signal. Each own task with a latest authoritative incorrect result contributes one more. Each signal adds 10 minutes, capped at 20 extra minutes. The baseline for each objective is its unseen time.

Today's objective is chosen from missed (more signals first), then started, then unseen, with objective IDs breaking ties. The estimator prefers an own task recommended by `planSession`, otherwise a reviewed `mc`, `short` or `case` task with current source support outside its same-task/family 24-hour cooldown. If no such check is available, the slice opens the objective lesson and says checks are unavailable or cooling down. Opening a suggested check preserves any existing draft and its recorded assistance.

Knowledge progress is `round(100 × (1 − objective remaining minutes / objective baseline minutes))`, clamped to 0–100. Flashcard catch-up is excluded from that bar. The stable-objective count and FSRS Review-card count remain separate visible summaries.

## Flashcard estimate

The read-only queue summary counts all projections, not just the queue's limited page. Available states 0, 1/3 and 2 count as new, learning and review respectively. Stale, suspended and missing cards are held. `initialized` means at least one projection exists.

**The assumed review time is 0.5 minutes per card (about 30 seconds).** Flashcard catch-up minutes are `max(0, due cards × 0.5 − original flashcard slice F)`. Catch-up is added to knowledge minutes; ordinary due work inside the daily slice adds nothing. An unstarted deck uses the catalog card count as its due and total counts, without initializing it. Unknown counts add no catch-up, and the UI labels the counts unavailable.

## Written-response estimate

The active task is the writing task with the newest current-version draft update or submitted attempt. Ties use task ID. With no activity, the community-archive task is preferred because its original practice mirrors the public Part I shape; otherwise the first writing task by ID is used. The five catalog parts remain derived practice, and the catalog titles remain unchanged.

For each part:

- **Drafted:** the latest current-version draft or any original submitted response has nonempty part text.
- **Feedback:** any saved judgment, including provisional approved AI or manual feedback, belongs to an attempt with nonempty text for that part.
- **Revised after feedback:** a later submitted response has different nonempty part text after the feedback timestamp on an earlier attempt. Whitespace-only changes do not qualify. A draft alone cannot meet this milestone.
- **Mentor-text evidence:** the newest current draft or attempt contains a straight- or curly-double-quoted span with at least three words that occurs in the bound mentor text. Matching lowercases, normalizes curly double quotes, collapses whitespace and trims end punctuation. Explicit saved mentor identity/version/hash must still match the bound text. This mechanical quote check does not judge the quality of the explanation.

Each part's progress is `(drafted + revised + mentor-text evidence) / 3`; feedback determines revision targets but is not a fourth percentage component. Essay progress is the rounded mean across parts. Undrafted parts need 30 minutes (15 for a first draft and 15 for revision with text evidence); drafted but unrevised parts need 15; revised parts without text evidence need 10; revised parts with text evidence need zero.

The next writing target is the first part in order with feedback but no revision, otherwise the first undrafted part, otherwise a drafted part needing feedback, otherwise a revised part needing mentor quotes. Buttons open the active task and that part through the existing draft-navigation guard.

## Remaining sessions formula

Let **k** be objective minutes plus flashcard catch-up, **e** be total essay minutes, and **K/E** be today's allocated knowledge/essay slices after the redistributions above.

- If both k and e are zero, remaining sessions are zero.
- If one track is empty, divide the other track's minutes by `K + E` and round up.
- Otherwise, advance both tracks together for `t = floor(min(k/K, e/E))` full sessions. For the track with the longer minutes/slice ratio, compute the remainder `r = its minutes − t × its slice`. Remaining sessions are `t + ceil(r/(K+E))`, because both study slices then go to that track. If r is zero or negative, use `max(ceil(k/K), ceil(e/E))`.

For example, k = 30 and e = 150 with 10/15/15 slices means two parallel sessions, followed by four sessions using 30 minutes on the remaining 120 essay minutes: **six sessions**. The formula is a coarse planning assumption, with rounded session boundaries and no automatic changes to saved work.

Completed study days are distinct Eastern calendar dates before today with at least one submitted attempt. While remaining sessions are positive, the display is `Session (completed days + 1) of about (completed days + remaining sessions)`. Draft-only days are not counted.

## Exported assumptions and verification

`study-estimate.ts` exports `STUDY_TIME_ZONE`, `EXAM_DATE`, `SESSION_MINUTES`, `MINUTES_PER_CARD`, `FOCUSED_STATEMENT_LIMIT`, `KNOWLEDGE_MINUTES`, `ESSAY_MINUTES`, `TIME_TILTS` and `PLANNING_NOTE`. It also exports pure calendar, normalization, classification, quote, essay, slice, session-count and full-estimate helpers for deterministic tests.

`tests/study-estimate.test.ts` uses the real catalog with synthetic history. The stable-objective unit fixture injects readiness statuses and coverage facts into `classifyObjective`; a second fixture projects stable Objective 0001 through the real readiness and coverage functions using synthetic observations on reviewed catalog families. The existing readiness and coverage suites retain their evidence-promotion checks. The suite also checks ET boundaries, focused/broad time, capped misses and authoritative supersession, essay milestones and quote identity, cooldowns, slice reallocation, flashcard catch-up, session-day counting, and deterministic read-only output. SQLite and Postgres queue tests verify summary counts and unchanged row counts; browser checks cover accessible bars, a 40-minute list, writing navigation and no desk-load POSTs.

## Change and verification report

| Area | Files changed |
| --- | --- |
| Shared estimator and queue contract | `packages/shared/src/study-estimate.ts`, `packages/shared/src/native-fsrs.ts` |
| Read-only queue summaries | `apps/server/src/native-store.ts`, `apps/server/src/postgres/native-store.ts` |
| Desk and guarded navigation | `apps/web/src/StudyProgress.tsx`, `apps/web/src/App.tsx`, `apps/web/src/Practice.tsx`, `apps/web/src/Writing.tsx`, `apps/web/src/styles.css` |
| Tests | `tests/study-estimate.test.ts`, `tests/native-store.test.ts`, `apps/server/postgres/hosted.pg.test.ts`, `apps/web/study-plan/e2e.spec.ts` |
| Documentation | `docs/study-plan.md` |

The worktree has Node 22.17.1 and no node_modules. No dependencies were installed. Typecheck, lint, Vitest, integration, Postgres and Playwright suites were not run. Node TypeScript syntax checks passed for changed `.ts` sources (not TSX); `git diff --check` passed. A dependency-free smoke run stripped the original pure readiness, coverage, planner and estimator bodies with Node, omitting the unavailable Zod schema declarations. It verified ET tilt, the real-catalog baseline (260 knowledge and 150 essay minutes), the six-session example, quoted mentor-text revisions and synthetic independent evidence making Objective 0001 stable. This smoke run does not replace the unrun application suites.

GitNexus upstream impact returned target-not-found / UNKNOWN risk for the affected application symbols in the parent Projects index. Local direct callers were inspected: the browser entry mounts App; App mounts Practice and Writing; Writing mounts WritingSession; the native queue methods serve the SQLite and hosted GET routes through the storage interfaces and feed Flashcards. The new projection adds no evidence-writing process. The pre-commit `detect_changes --scope all --repo Projects` attempt returned a not-a-git-repository diagnostic and no valid change-impact result.

### Test names added

Estimator cases in `tests/study-estimate.test.ts` (27 cases including six parameterized dates):

- uses the date tilt at %s (six ET boundary dates)
- uses ET even when the UTC date is different and clamps the exam countdown
- requires a valid injected clock
- gives a stable objective zero remaining minutes only with both readiness and coverage
- projects stable Objective 0001 from real catalog families and synthetic independent evidence
- gives an unseen focused objective one 15-minute slice and a broad objective 25 minutes
- adds ten minutes per recent miss signal capped at twenty extra minutes
- uses the latest authoritative own-task judgment and ignores provisional supersession
- uses effective judgment chronology when an older attempt receives a late correction
- only offers reviewed knowledge tasks outside the family cooldown
- budgets 150 minutes for five undrafted parts and selects the public-shape practice task
- gives drafted-only parts fifteen remaining minutes and one-third progress
- counts a changed submission after provisional feedback as revised but still needs text evidence
- finishes revised parts only when the latest part text quotes at least three bound mentor words
- requires feedback before a different preserved response and ignores whitespace-only revisions
- uses the newest current-version draft for evidence and leaves archived drafts separate
- selects the writing task with the most recent current activity and targets parts in order
- uses the documented parallel-session formula with completed-track reallocation
- reallocates empty tracks and zero-due flashcards while unknown flashcards keep maintenance
- adds only flashcard backlog beyond the daily slice to knowledge minutes
- counts session N and about-total by distinct ET dates before today
- is deterministic, read-only, totals forty minutes and uses bounded planning language

Browser cases in `apps/web/study-plan/e2e.spec.ts`:

- desk exposes two accessible progress bars and a 40-minute plan without POSTs, then opens its essay task
- knowledge slice opens its named check with the objective lesson preselected
- saved feedback prioritizes Part 2 and opens that writing part without preserving a new response
- unavailable flashcard summary keeps maintenance time and the mobile plan usable
- Refresh rereads both summaries using GET and reallocates a zero-due flashcard slice

Native queue cases:

- summarizes all available FSRS states and held cards before limiting the read-only queue (SQLite)
- returns an uninitialized or complete native summary with SELECT-only queue reads (Postgres)
- Extended: keeps empty and enrolled queue reads free of database writes (SQLite)
