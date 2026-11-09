# SEI Study Lab

A local study desk for Massachusetts MTEL Field 56: curriculum, retrieval practice, original lesson-planning practice and transparent evidence. Independent application; no official affiliation. January 16, 2027 is a planning target, not a booked exam. No prior conversation has been imported as successful work.

## PowerShell quickstart

Run in this folder:

```powershell
cd path\to\sei-study-lab
node --version
npm --version
npm ci
npm run content:validate
npm test
npm run dev
```

Open http://127.0.0.1:5173. The API binds only to 127.0.0.1:4317. Port collisions stop startup with an error; stop the conflicting process first. Press Ctrl+C to stop development.

For the built application:

```powershell
npm run build
npm start
```

Open http://127.0.0.1:4317. Run commands from the repository root so content and migration paths resolve. Internet is needed for initial npm installation; after installation/build the study workflow requires no network connection. Source fetching is a separate deliberate development action, never part of startup. No model calls, CDN assets, telemetry or accounts.

## Study workflow

1. Open Learn & practice. Read a short lesson or start a diagnostic directly. Soft prerequisite recommendations never block practice.
2. Answer a check, request a recorded hint, or choose “I don't know.” Authored keys provide specific wrong-turn feedback. Unmatched short wording and open responses remain for review; keyword absence never fails an essay.
3. Save drafts and revisit the response archive. Revisions create new attempts; original answers remain unchanged. Hint/revision metadata travels with practice drafts.
4. Use Evidence to see eligible counts, item families and dates. Independent evidence requires checked tasks/judgments, no assistance, different families and at least 24 hours. A later failure triggers a recheck. These rules are educational heuristics, not pass predictions.
5. Writing studio holds one exact original mentor text across five custom parts, with editable timing and a diagnostic rubric. Each discipline has a separate task/draft. These are derived exercises, not invented official Parts II–V.
6. Data & handoff exports evidence JSON, Anki TSV, and selected manual review packets. Preview and explicitly confirm imports/proposal approvals. Nothing is sent to Grok or another service automatically.

The full framework inventory contains 13 objectives and 60 statement records: 59 descriptive bullets plus the objective 0013 referral to objectives 0001–0012. Separate inventories retain 11 endorsement competencies and five teacher indicators. Installed content: **12 lessons, 56 checks (47 MC + 9 short), 9 cases, 18 cards, 2 original mentor texts and 2 five-part writing tasks**, with 9 derived skills and 23 crosswalk links. The Objective 0004–0006 slice appends three scaffolded lessons, thirteen distinct-rule checks, three unfamiliar nonmath cases and six recall cards to the preserved earlier curriculum. Coverage remains partial. All 67 tasks are source-checked by model-assisted comparison; **none are human-reviewed**.

The Standards map shows explicit partial scope and gaps for every statement, separately from broad skill mapping and learner evidence. The Study desk proposes a deterministic three-track session with reasons, saved-draft limits, and 24-hour family cooldowns; you can open any existing task instead. Coverage contract v3 preserves all 25 earlier bindings and appends 24 narrow bindings across the sixteen unchanged Objective 0004–0006 statements. All 13 objectives retain gaps. See [coverage/planner behavior](docs/coverage-and-planner.md), the [Objective 0001 review](docs/obj0001-identification-review.md), the [Objective 0002/0003 review](docs/obj0002-0003-review.md), and the [Objective 0004–0006 source comparison and validation limits](docs/obj0004-0006-review.md).

The thirty earlier source snapshots remain unchanged. Ten Objective 0004–0006 inventory entries preserve supplied excerpts, exact URLs, edition cues and supplied binary hashes, with researcher retrieval November 8, 2026, America/New_York; Codex did not fetch or independently validate these documents. S8 is metadata only because no substantive appendix excerpt was supplied. WIDA domain snapshots never determine ability or restrict rigorous content; Can Dos supplement standards and are not yet updated to the 2020 Edition. WWC vocabulary/oral-language recommendations retain their K–8 scope and Strong ratings without invented effect sizes. Beck tier rules, acquisition timelines and full-document verification remain gaps. Earlier policy qualifications remain in the [Objective 0002/0003 review](docs/obj0002-0003-review.md); the [new review](docs/obj0004-0006-review.md) records current claim-to-source mapping. The offline authoring recipe appends hash-reviewed records, including cards, and refuses same-key conflicts; it does not regenerate old versions or create learner evidence.

Extended-response judgments remain provisional, including locally approved external proposals. They do not promote readiness. The seeded unfamiliar cases therefore cannot yet earn transfer_evidence; adding a carefully reviewed human adjudication workflow is a future step. No scoring-agreement validation or human rubric-anchor study is claimed.

## Data and privacy

Native Flashcards reviews the twelve preserved starter cards and six appended Objective 0004–0006 recall cards using pinned `ts-fsrs` 5.4.2 (FSRS-6) on Node 22.17.1. Reveal before rating; typed recall and assistance are preserved, and ratings never promote learning evidence. See [native scheduling, recovery, backup limits, and actual verification](docs/native-flashcards.md).

After opening the native deck, legacy JSON export is blocked because its format cannot preserve native history. Use the consistent SQLite backup below for all accepted reviews. Native JSON import/export is deferred; older evidence-only imports remain supported. Browser drafts and pending review receipts are separate local working data and are not included in a SQLite backup.

SQLite stores data in ignored runtime/study.sqlite (including WAL/SHM). Back up with:

```powershell
npm run db:backup
```

This uses SQLite's supported consistent backup API. There is no destructive reset command. Full backups include drafts and handoff packets. JSON interchange includes original attempts, judgments, evidence and matching catalog snapshots; it does not include drafts or pending handoff packets. An import requires compatible locally installed catalog versions and cannot overwrite history. Requests/imports are limited to 2 MB.

Browser downloads go to your browser's configured download folder. They may contain private answers; move private exports under runtime/ if you want them inside this repository. Do not add them to Git. The tracked docs/examples files contain synthetic demonstration data only and are not seeded into the app. A synthetic packet demonstrates the format; its returned proposal is not approvable in an unrelated database because packet identity must be locally known. Create a new packet after importing the synthetic attempt to try a round-trip.

Per-session CSRF tokens, exact Host/Origin checks, parameterized SQL, bounded JSON, safe text rendering and append-only SQL triggers protect the local API. Secrets are never frontend configuration. Test databases are separate under ignored runtime/. Never add real student information.

## Runtime and validation

Tested on Windows PowerShell with **Node 22.17.1 and npm 10.9.2**. Built-in node:sqlite provides DatabaseSync and backup but prints an experimental warning on this runtime. Node 24 LTS is the preferred future runtime; it was not installed or tested here. No native SQLite addon is required. Dependencies are locked in package-lock.json; exact direct versions and actual validation results are in [handoff manifest](docs/handoff-manifest.json).

```powershell
npm run typecheck
npm run lint
npm run test:integration
npm run test:e2e
```

Browser tests use the already installed Microsoft Edge (Playwright channel msedge), with external requests blocked, isolated ports 5174/4318, and a synthetic database. They do not connect to a running learner app on 5173/4317. No browser binary was downloaded. If Edge is unavailable elsewhere, browser tests require a user-provided supported browser; optional explicit command `npx playwright install chromium` downloads Chromium, after which change Playwright channel selection to the default Chromium. This command was not run here.

See [implementation status](docs/implementation-status.md) for commands actually run and limits. Build may emit harmless Zod comment-annotation notices. ESLint 9 is retained for tested compatibility (npm marks its support lifecycle deprecated); the dependency audit is clean. A narrowly scoped minimatch 11.0.5 override patches the typescript-eslint transitive dependency and was tested with lint/typecheck.

## Further development

[Architecture](docs/architecture.md), [data schema](docs/data-schema.md), [content-review checklist](docs/content-review-checklist.md), [Anki workflow](docs/anki-workflow.md), and [decisions/TODO](docs/decisions-and-todo.md) explain the boundaries. Anki TSV does not synchronize reviews. AnkiConnect, model adapters and BKT are deferred.

The user has authorized public source-code review on GitHub. Local runtime databases and private answers remain excluded. Publishing the source does not deploy the application; it remains single-user localhost software. Future hosting, model connections, or private-data sharing require separate authorization.

## Source-code review

Start with [the repository review brief](docs/repository-review.md). [The publication manifest](docs/publication-manifest.json) lists the exact candidate files and their hashes. Private runtime data and generated outputs are excluded. The manifest records the source-only publication boundary; it excludes runtime data and deployment artifacts.


## Review fixes and upgrades

See [review-fix behavior and safe restart](docs/review-fixes.md) for evidence policy v2, awaited navigation saves, archived task history, and deliberate old-version draft copying. Existing version-1 databases receive a consistent pre-migration backup before the versioned-draft upgrade. The [Grok handoff](docs/grok-review-handoff.md) identifies the re-review scope and the limits of direct agent communication.
