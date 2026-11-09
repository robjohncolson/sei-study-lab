# Native flashcards: implementation and preservation limits

This slice uses the existing twelve authored starter cards. It adds no curriculum and makes no claim of comprehensive coverage. Reveal freezes the learner's prior recall response; after revealing the answer, the learner self-rates that recall ease. The rating is not keyed correctness, SEI comprehension, independent evidence, transfer, objective mastery, or an exam-pass probability. Native events never enter `evidence_events`, readiness, or statement coverage. Blank, pasted, hinted, and assisted responses remain recall context only.

## Scheduler and identities

The sole native scheduling implementation is `ts-fsrs` **5.4.2**, FSRS-6, on the existing Node **22.17.1** runtime. The dependency uses MIT and declares Node >=20. The manifests contain exactly the coordinator's npm-generated patch, with no other dependency changes:

- `package.json` SHA256: `f9689f2b4cdaf9da2a72d83679b48a62ba213d9b7ae878e3c21a44eabc5e1595`
- `package-lock.json` SHA256: `dc73e0a1328c5063fbd913107d96ec5219912c6ed4ef76d00721f97c2c6aa121`

`generatorParameters({request_retention:0.9,enable_fuzz:false})` supplies the complete defaults, including all 21 weights and learning/relearning steps. `fsrs(parameters).next` produces both the persisted card and log. Reset calls the library's `forget(card, serverNow, true)` and records its exact Manual log, including signed `scheduled_days` when reset precedes the prior due date. This exception is limited to Manual logs; card schedules and ordinary review logs remain nonnegative, and self-rating Manual/0 is rejected. No interval calculations, optimizer, personal training, BKT, or model calls are implemented. The canonical configuration hash covers schema/library/model identifiers and the full parameter object, excluding the hash field itself. The supplied default snapshot yields `2be6f90cea266a64acd9db252d5023c38a10c27060ef759857d130147151440b`; unknown configurations and inconsistent hashes are rejected.

Card content identity is the existing stable ID plus SHA256 of canonical JSON containing every card field: id, front, back, source, tags. Unicode, whitespace, and tag order are preserved. Existing catalog records are unchanged. Every native init/review/control event includes its content snapshot and fingerprint, configuration/hash, exact request/hash, server instant, pre/post projection, and library log where applicable. A review request includes the exact typed response, reported assistance/hints, reveal/start timestamps, rating, client-event UUID, and expected projection version.

The injected server clock owns UTC due times. Client timestamps only describe provenance. They must follow start <= reveal <= submission, cannot be over five minutes ahead of server time, and cannot precede the acknowledged projection's server timestamp by over five minutes. A frozen request may be delivered after a long offline delay; it is scheduled at the actual server receipt instant. An exact duplicate bypasses current-time/version checks and returns its original receipt indefinitely. Different payloads under an existing client ID and stale expected versions return 409 without changing history or projection. Both review and control writes retain Host/Origin/CSRF validation.

## Storage, queue, and changed content

Migration 003 adds `native_scheduler_configs`, `native_card_versions`, `native_flashcard_events`, and `native_flashcard_projections`. The first three have UPDATE/DELETE rejection triggers. A transaction covers each event and its projection update. Native storage has its own adapter boundary and shares the existing SQLite connection; there is no cloud adapter.

Opening the Flashcards workspace sends a Host/Origin/CSRF-protected `POST /api/native-flashcards/initialize`, recording one immutable due anchor per new card, then reads the queue. Retrying initialization is idempotent, including after a lost response. `GET` and `HEAD /api/native-flashcards` are read-only; ordinary startup and opening the study desk do not initialize the deck or disable legacy export. Startup deterministically rebuilds projections from validated events/configurations/content and recorded init anchors; it never uses current time to recreate old schedules. Corrupted cached projections are disposable. Existing file databases require `SeiStore.open()` and a consistent SQLite backup before migration 003. No old catalog, response, judgment, or evidence rows are rewritten by this migration.

The queue returns at most 50 due cards (the storage API accepts a bounded limit of 1–100). Learning/relearning precedes other due cards, then ascending UTC due instant and ordinal card ID break ties. Suspended, stale-content, and missing cards are held outside the due queue. Native schedules display America/New_York time with EST/EDT and their UTC ISO provenance; the date-only source helper is unchanged.

Changed content requires Keep, Reset, or Suspend to acknowledge its new fingerprint. Keep leaves the library card unchanged; Reset records official library reset output; Suspend retains the schedule and excludes the card. Suspended cards remain visible and can be resumed. A stale suspended card must acknowledge its revision before Resume. Removing a card from the catalog is the current catalog model's retirement mechanism: its history remains, and it cannot receive current reviews. No pending response is reassigned to a new card/version.

## Browser recovery

The answer is absent from the review DOM until Reveal. Revealing freezes the optional typed response. Native buttons support keyboard use, move focus on reveal/acceptance, announce status, and provide mobile touch targets. Paste events, reported help, and use of the recall hint are retained as assistance.

Browser-scoped durable storage holds unfinished work separately from task/writing drafts. Every edit is saved synchronously; the complete pending review/control ID and payload are frozen before POST. Navigation and reload recover those bytes. Delayed, failed, and response-lost requests remain pending, and Retry uses their original payload. The server's receipt identity/version must match before clearing. In-flight guards prevent duplicate UI submissions; server idempotency remains authoritative. A stale/conflicting draft is held visibly. Explicitly closing it keeps an exact browser recovery copy that can be downloaded, and a later review starts blank.

Storage failures block new requests and guard workspace navigation. Unreadable browser data is retained and can be downloaded for recovery. Comparing previously read storage bytes prevents a later editor from silently overwriting changed data; this is not an atomic transaction across multiple browser tabs. Use one active review tab. Browser recovery copies are local working data and are never treated as accepted evidence.

## Backup and interchange boundary

**Native JSON import/export is not implemented in this bounded slice.** The blocker is the lack of a validated native interchange envelope that can atomically validate and merge configuration, card-version, init/control/review identity chains and reconstruct projections. The old evidence-only envelope cannot carry that history safely. Once native init/history exists, `exportData()` and `/api/export` explicitly refuse a legacy JSON export and direct the user to `npm run db:backup`. The Data & handoff and Flashcards workspaces disclose the limit. Unknown scheduler/native fields are rejected by the existing strict import schema; cached schedules cannot be imported as authority.

Old evidence-only exports remain importable through their existing preview/confirmation flow and cannot change native history. Before native initialization, old JSON export behavior remains compatible. Consistent SQLite backups include every native table and accepted event, alongside existing data; do not copy a live SQLite main file alone. SQLite backups do not include unfinished browser drafts/pending receipts/recovery copies. Resolve or separately save those browser copies before moving profiles or devices. There is no native JSON merge/restore UI or preservation claim for browser data in a database backup.

Optional Anki TSV remains one-way card-content export with `reviewsSynchronized:false`. Native FSRS owns this app's schedule; Anki does not feed back reviews or due dates. AnkiConnect remains deferred.

## Verification in the Athena worktree

The clean branch/base identity was verified against `athena/20261108-213150-e31169` at `9d977577844f65eb9d4895d3d01666774eec3beb`. The 26 authorized source files were rehydrated byte-for-byte from `aaabbb29578d63db7057399479e1adf133540113` using read-only `git show`, then narrowly repaired. The catalog and npm-generated manifest/lock remain byte-exact. GitNexus upstream queries for the affected native schema, queue, workspace, and server symbols in the parent Projects index returned not found / UNKNOWN risk. Local callers were inspected: serialization and immutable event replay consume the log schema; the queue API and storage tests call `queue`; `App` mounts the Flashcards workspace, whose refresh uses `api`. The history-mutating GET was treated as high risk; the Host/Origin/CSRF guard is unchanged. UNKNOWN is not a clearance.

GitNexus `detect_changes --scope unstaged --repo Projects` produced a not-a-git-repository diagnostic for the parent index. It did not provide a valid change-impact result. The bridge owns staging/commit; the agent left the index untouched.

Node is 22.17.1. No dependencies are installed in this worktree. Typecheck, lint, build, content validation, unit/integration tests, and browser tests were not run; the prepared BOX environment must retest this final source. The coordinator reported 178 passing and two failing tests out of 180, 57 integration passes in a subset, and 25 Chrome browser passes for the prior revision, not these repairs. No package manager provisioning, network calls, browser/model downloads, runtime data access, or migration execution were performed here.

Dependency-free checks passed for all 13 authorized `.ts` files using Node's TypeScript syntax check without module execution, manifest/lock JSON and version pins, exact manifest/catalog hashes, whitespace, and preservation of existing test declarations without skips. These do not typecheck the application or validate TSX, runtime library semantics, or browser behavior.

Added test sources cover the supplied independent four-rating new-card outputs and configuration hash, overdue server timing for all ratings, card/log serialization, deterministic replay, revision controls, idempotency/conflicts, rollback, no evidence promotion, API security, and browser recovery including response loss. The supplied external numeric fixtures cover fresh cards only; overdue tests check server timing, deterministic output and roundtrip behavior, without claiming independent numeric overdue fixtures. All library-dependent tests remain unrun here. Existing test assertions and source-archive digest fixtures are preserved.

Repair regressions retain both original failing reset tests and compare before-/after-due resets directly with pinned library output, including full card/log roundtrips and history replay. Negative ordinary review logs/cards and self-rating Manual/0 remain rejected. Storage tests enforce read-only queries and idempotent enrollment. API tests cover unauthenticated GET/HEAD, legacy export before enrollment, invalid/expired initialization sessions, and repeated protected initialization. A browser regression covers lost initialization responses, Reload, reopening, preserved anchors, and unchanged evidence.

## Changed source inventory

- Dependency source: `package.json`, `package-lock.json`.
- Scheduler contracts/adapter: `packages/shared/src/native-fsrs.ts`, `apps/server/src/native-scheduler.ts`.
- Storage/API: `apps/server/src/native-store.ts`, `apps/server/src/migrations/003-native-flashcards.sql`, `apps/server/src/store.ts`, `apps/server/src/app.ts`.
- Browser: `apps/web/src/Flashcards.tsx`, `apps/web/src/native-flashcard-draft.ts`, `apps/web/src/flashcard-time.ts`, `apps/web/src/App.tsx`, `apps/web/src/api.ts`, `apps/web/src/Exchange.tsx`, `apps/web/src/styles.css`.
- New tests: `tests/native-scheduler.test.ts`, `tests/native-store.test.ts`, `tests/native-flashcard-draft.test.ts`, `apps/server/native.integration.test.ts`, `apps/web/flashcards/e2e.spec.ts`.
- Documentation: `README.md`, `docs/native-flashcards.md`, `docs/architecture.md`, `docs/data-schema.md`, `docs/anki-workflow.md`, `docs/implementation-status.md`.
