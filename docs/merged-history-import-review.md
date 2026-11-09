# Merged-history and writing-import repairs

Base reviewed and inspected: `e9a521c59a7afba2595cfd54c30eb7a23fc04d41`.

`getReadiness` retains an authoritative, originally eligible failure as a recheck
signal when merged history makes that observation feedback-dependent. Exclusion
does not prove recovery. Clearing this signal requires a strictly later success
that is both recorded eligible and effectively independent under evidence policy
v2, including its 24-hour same-family retest cooldown. Same-time successes and
immediate corrections cannot clear it. Superseding judgments still determine the
authoritative judgment. Original attempts, judgments, and evidence remain intact;
this changes only the derived readiness interpretation.

`SeiStore.inspectImport` resolves mentor identity from the immutable task's
`mentorTextId`, `mentorTextVersion`, and `mentorTextSha256`, checks the installed
text's digest, and requires the attempt's mentor identity to match. Every writing
answer must pass the existing five-part validator, including provisional work.
An unavailable or incomplete historical binding fails closed; the active mentor
is never used to invent it. Historical task snapshots with complete bindings can
still import when a newer task/mentor is active or retired. Preview and actual
import share validation; actual import retains the existing transaction boundary.
No records, database histories, or original answers are rewritten.

Twenty new in-memory integration cases cover both import orders, reordered merged
roundtrips, preserved records, correction/retest behavior, malformed writing,
missing mentor metadata, installed mentor mismatches, historical/retired versions,
atomic API/store rejection, and valid writing proposal approval. The existing
synthetic writing task fixture now records the same explicit mentor binding as
the authored catalog. Existing same-millisecond regressions remain unchanged.

## Validation in the allocated sandbox

Node: `v22.17.1`. No dependencies were initially installed. No tests executed;
there are no passing-test counts to report. Repairs remain unverified.

Commands attempted:

| Command | Result |
| --- | --- |
| `npm ci --offline --ignore-scripts --cache .test-npm-cache --logs-max=0` | Exit 1, `ENOTCACHED` for Zod 4.6.7; npm also reported cleanup EPERM. No network fallback. |
| `npm --logs-max=0 test -- tests/review-regressions.test.ts apps/server/integration.test.ts -t "reviewed merged-history\|ambiguous simultaneous\|immediate correction"` | Exit 1: Vitest unavailable; npm also omitted `-t` from the displayed invocation. No tests ran. |
| `npm --logs-max=0 test` | Exit 1: Vitest unavailable. |
| `npm --logs-max=0 run test:integration` | Exit 1: Vitest unavailable. |
| `npm --logs-max=0 run content:validate` | Exit 1: tsx unavailable. |
| `npm --logs-max=0 run typecheck` | Exit 1: tsc unavailable. |
| `npm --logs-max=0 run lint` | Exit 1: ESLint unavailable. |
| `npm --logs-max=0 run build` | Exit 1 at typecheck: tsc unavailable. |
| `git diff --check` | Passed. |

Browser regression was not run: Playwright dependencies are absent, and the
existing server runner creates a protected `runtime/` database. Existing disk
integration tests likewise require protected runtime/database/backup artifacts.
No browser installation or protected-path test execution was attempted. New
regressions use SQLite `:memory:` and synthetic fixtures only.

GitNexus upstream impact was attempted for `getReadiness` and `inspectImport`
using `--direction upstream --repo Projects`. Both symbols were absent from the
parent index; risk is UNKNOWN. Local direct callers are the web `App` readiness
helper and tests for `getReadiness`, and the preview API plus transactional
`importData` for `inspectImport`. Relevant processes are readiness display and
import preview/acceptance; the reviewed changes have medium behavioral risk.
`gitnexus detect_changes --scope all --repo Projects` was also attempted, but
reported that its indexed location was not a Git repository, so it supplied no
usable change analysis. No manual commit or staging was attempted; bridge commit
is deferred pending successful validation as requested.
