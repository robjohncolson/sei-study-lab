# Implementation status and actual verification

The hosted storage/auth foundation is additive behind `STORAGE_MODE=postgres`;
SQLite remains the default. It supports native flashcards and owner identity only,
with private-schema Postgres migrations and an isolated real-Postgres test suite.
No history upload, hosted browser login, or deployment is included. Dependencies
are absent in this sandbox, so runtime verification remains with the coordinator.
See [hosted architecture, provisioning, hash checks, and limits](hosted-mode.md).

The native flashcard slice is implemented on top of clean base `9d977577844f65eb9d4895d3d01666774eec3beb`, with the supplied exact ts-fsrs 5.4.2 manifest patch. **Its library-dependent checks are unrun in Athena:** dependencies are absent, and typecheck/lint/test cannot start. No install was attempted. The successful counts below are historical, not validation of the native slice. See [native changes, available smoke checks, and preservation blockers](native-flashcards.md). Native JSON interchange is deferred and legacy export is blocked after deck initialization; consistent SQLite backup preserves accepted native history.

| Slice | Working result | Remaining limits |
|---|---|---|
| 1 — local shell and inventory | React/Vite + Fastify; SQLite migration; loopback Host/Origin/CSRF; complete 13-objective inventory; separate competencies/indicators; DAG validation | Node 22 SQLite is experimental; Node 24 not tested |
| 2 — practice | Six lessons,24 checks,3 cases; bounded keys and wrong-turn feedback; unknown wording queues review; persisted drafts/hints/revisions and attempt history | Model-assisted content review only; most objectives have coverage gaps |
| 3 — evidence and interchange | Immutable attempts/judgments/events;24-hour distinct-family rules; failure recheck; bounded transactional idempotent import, preview and conflicts | Compatible catalog versions must already exist; imports exclude working drafts/packets |
| 4 — Anki and manual review |12-card TSV; selected-data Markdown/JSON packet; version/quote validation; explicit local proposal approval | Reviews not synchronized; no AnkiConnect; proposals remain provisional |
| 5 — writing | Two original discipline texts; five derived parts each; exact text/version/hash; persistent writing; official rubric definitions | No validated automated scoring, human adjudication/anchor study; seeded transfer evidence remains unavailable |
| 6 — optional integration | Deliberately deferred | No model endpoints, cloud calls, BKT or model downloads |

## Checks actually run on November 8, 2026

- `node --version`:22.17.1; `npm --version`:10.9.2. Built-in DatabaseSync and backup verified.
- `npm install`, patched dependency installation, and final `npm ci`:passed. Initial clean-install attempt hit Windows EPERM while a test process held Rollup; stopped owned processes and retried successfully, without administrator access.
- `npm audit`:zero vulnerabilities after patches and scoped minimatch override; final npm ci independently reported zero.
- `npm run content:validate`:passed.13 objectives;60 statement records;11 competencies;5 indicators;9 skills;23 alignments;5 DAG edges;6 lessons;29 tasks;12 cards;2 mentor texts;1 rubric;13 sources;42 review events.
- `npm test`:31 passed across2 files (13 shared-rule tests plus18 backend integration tests).
- `npm run test:integration`:18 passed. Covers append-only SQL, restart/drafts, idempotence, conflict rollback, forged evidence, chronological comparisons, reordered revisions, safe JSON, mentor identity, proposal identities/quotes and consistent WAL backup.
- `npm run typecheck`, `npm run lint`, `npm run build`:passed. Build prints nonfatal Zod comment-annotation notices. ESLint9 lifecycle deprecation is documented.
- `npm run test:e2e`:4 passed using installed Edge156.0.4314.58. Keyboard/hint/recovery, all-part writing text identity, explicit import confirmation, Anki no-sync; real API persistence/all13 coverage; external requests blocked; Vite runtime-file access rejected403. Screenshot inspected for layout.
- `node scripts/smoke-built.mjs`:passed compiled production server startup, frontend200, catalog13, empty isolated database, and untrusted-origin403. This invokes the same built entry as `npm start`; the npm start alias itself is documented rather than separately run.
- `npx tsx scripts/create-demo.ts`:generated synthetic examples using an in-memory database. No learning attempts seeded in the default runtime database.
- `git status --short`, `git check-ignore`, `git remote -v`:checked. Runtime databases/WAL/backups/exports and secrets ignored; no remote. Nothing staged or committed.

`npm run dev` was actually exercised by Playwright. `npm run db:backup` is documented for a user's real database; consistent backup behavior was tested using a temporary WAL database instead. No browser installation command was run. No default learner database was used by tests.

An intermediate browser run was interrupted by the overlapping clean-install attempt and failed due to removed dependencies. The final independent browser rerun after npm ci passed all4 tests; the interrupted run is not counted as a passing run.

## Review repair verification — November 8, 2026

The original 31-test snapshot above is historical. After reproducing and repairing Grok's four findings:

- `npm test`: **54 passed** across three files (31 backend integration tests and 23 shared policy/schema tests).
- `npm run content:validate`: passed; curriculum counts are unchanged.
- `npm run typecheck`, `npm run lint`, `npm run build`: passed for the repaired code.
- Browser regression results for the final repaired snapshot are recorded in the handoff manifest after the stable rerun. Browser tests now use isolated ports 5174/4318 and a synthetic database, never a running learner app on 5173/4317.
- New backend checks cover consistent pre-migration backup, exact legacy-draft preservation, historical task/source snapshots, unchanged event bytes on import, recorded generation-context validation and stricter merged-history interpretation.
- New policy checks cover wrong/right immediate revisions, dropped parents, delayed fresh starts versus held drafts, same-family version changes, legacy eligible flags, archived successes/failures, retirement, and same-millisecond ambiguous corrections retaining needs_recheck.
- A live local session was left running and untouched. No real learner database was opened for these repairs. Stop/restart the app to load the new backend and perform the automatic backed-up migration.

GitNexus impact calls could not resolve the new application symbols. Its change-detection result targeted the larger parent Projects index and unrelated parent changes, so it is not an authoritative scope check for this nested repository. The repository-local publication manifest, Git staged-file audit, regression tests and staged diff provide the applicable scope checks. No files outside sei-study-lab are included in publication.

Final stable browser rerun: `npm run test:e2e` **12/12 passed** using installed Edge and isolated ports 5174/4318. The suite includes rapid navigation, writes in flight, failed-save blocking, submission/lineage-save races, hydration protection, browser-close warning, prior-version draft copying and real Fastify/SQLite persistence. External browser requests were blocked. No source edits occurred during the final stable run. An earlier browser run was disrupted by concurrent source hot reload; it is not counted as the final result.
