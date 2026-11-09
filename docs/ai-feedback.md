# Optional essay feedback

DeepSeek feedback is an optional, provisional, unofficial reading of a preserved
writing attempt. It does not predict passing, act as an official MTEL scorer, or
create independent learning evidence. The local Grok handoff remains unchanged.
Catalog wording, derived writing prompts, and FSRS are unchanged.

## Consent and privacy

Writing shows the optional panel after a submission has been preserved. First
select **Show exactly what will be sent**, review the data, and check the consent
box for that request. Consent resets after every request and whenever the selected
preserved attempt changes. Previewing never calls the provider or consumes budget.
The server rebuilds the preview hash before sending, so a stale preview is rejected.

The panel displays this notice:

> Sends this essay, the task, the mentor text and the rubric to DeepSeek. DeepSeek
> (Hangzhou DeepSeek AI Co.) states that it processes and stores data in the
> People's Republic of China. Do not include names or student information.

Only the stored task title, prompt and parts; the bound mentor title and text;
the rubric criteria and scale; and original answer parts are sent. The server
does not send owner/attempt IDs, timestamps, sessions, IP addresses, hints, names
from account metadata, or other attempts. Names typed into an essay would be part
of its text, so remove sensitive information before preserving a submission.
Existing original answers are immutable; edit and submit a new attempt if needed.

The provider response must pass a strict schema and literal-answer-quote checks.
Criterion comments use only Purpose, Subject Matter Knowledge, Support, and
Rationale from `rubric.mtel56.public@1`. There are no numeric criterion scores.
The single provisional holistic score is 1–4, U, B, or unassigned. U/B gates come
first; uncertainty, missing parts and borderline judgments require human review.
**Save as provisional feedback** is a separate, explicit action. It appends an
`ai_approved_proposal` judgment with `needs_review`, `provisional: true`, and
`sourceChecked: false`. Repeating approval for one request does not duplicate it.
Saving does not constitute authoritative human scoring or independent evidence.

## Backend configuration

Set these only in the server's process environment or the hosting provider's
backend configuration. No client-prefixed variables, credentials in source, or
credential files are needed. Configuration errors identify the setting, never
its value.

| Setting | Default and meaning |
| --- | --- |
| `DEEPSEEK_API_KEY` | Optional; absent or blank makes feedback unavailable. |
| `AI_FEEDBACK_MODEL` | `deepseek-flash`; accepts only `^deepseek-[a-z0-9.-]+$`. |
| `AI_FEEDBACK_DAILY_BUDGET_USD` | `2`; `0` disables feedback; maximum `50`. |
| `AI_FEEDBACK_DAILY_REQUEST_CAP` | `60`; integer from `1` to `1000`. |
| `AI_FEEDBACK_PRICE_INPUT_MISS_PER_M` | `0.30` USD per million uncached input tokens. |
| `AI_FEEDBACK_PRICE_INPUT_HIT_PER_M` | `0.006` USD per million cached input tokens. |
| `AI_FEEDBACK_PRICE_OUTPUT_PER_M` | `1.20` USD per million output tokens. |
| `AI_FEEDBACK_MAX_OUTPUT_TOKENS` | `1800`; maximum output requested from the provider. |

The endpoint is fixed to `https://api.deepseek.com/chat/completions`; there is no
production base-URL override. The adapter uses server-side Bearer authentication,
JSON response mode, `thinking: {type: 'disabled'}`, redirect rejection, and a
50-second timeout. The prompt includes JSON instructions and an example. Blank,
truncated, malformed, nonliteral, or otherwise invalid output is rejected with a
safe error. Complete essays and outbound payloads are not copied into the AI
request ledger, and raw model output is never stored. Only a validated proposal,
including its literal answer quotes, can occupy `proposal_json`. Request/response
bodies, authentication headers, and keys are never logged.

The model name and price defaults come from the task's verified DeepSeek
documentation snapshot dated **2026-11-09 ET**: `deepseek-flash` is
DeepSeek-V4.1-Flash. See the provider's [models and pricing documentation](https://api-docs.deepseek.com/quick_start/pricing)
and [JSON output documentation](https://api-docs.deepseek.com/guides/json_mode).
Peak prices are the conservative defaults; off-peak discounts are ignored.
This implementation did not make network calls to recheck documentation or the
provider. Operators should review provider changes before enabling another model
or changing prices.

## Storage and budget accounting

The Postgres operator script is
`apps/server/src/postgres/migrations/003-sei-ai-feedback.sql`. Apply migrations in
order **000, 001, 002, 003**, using the same operator role and ownership constraints
as the earlier scripts. Migration 003 is rerunnable. It is never applied by hosted
startup. The harness includes it in both migration passes. The local SQLite schema
adds `apps/server/src/migrations/004-ai-feedback.sql` through the existing
`schema_migrations` mechanism and consistent backup procedure.
No SQL was executed as part of this sandbox implementation.

`ai_feedback_usage` tracks one owner and **America/New_York calendar day**, including
daylight-saving transitions. Requests reserve integer micro-USD before provider
I/O: rounded-up input characters divided by three at the cache-miss price, plus
the maximum output tokens at the output price. The transactional reservation
checks spent plus existing reservations plus the new estimate against the daily
cap and increments the daily request count. Concurrent calls share this check.

After a response, reported prompt/cache/output token usage reconciles the
reservation to the actual configured-price cost. Missing or unusable usage keeps
the reservation charged conservatively. Invalid feedback still consumes budget.
A network failure before receiving a response releases its cost reservation but
still counts as a request. Unfinished reservations remain reserved; a process
crash cannot silently refund uncertain provider work. Reconciliation uses the
reservation's original day even if the request crosses midnight. The status
route rounds spending to two decimal places; server-side integer accounting is
authoritative, including in-flight reservations.

Postgres enables and forces owner RLS on both new tables, with policies using
`sei.request_owner_id()`. The app role has SELECT/INSERT/UPDATE on usage and only
SELECT/INSERT on requests, with no DELETE or TRUNCATE privilege. Request IDs and
attempt references are owner-scoped. In **public hosted mode**, every visitor
shares the configured owner, study history, and daily AI budget. Origin and CSRF
guards still apply; public mode does not provide individual visitor authentication.

## Routes and operation

Both local SQLite and hosted Postgres expose:

- `GET /api/ai-feedback/status`: availability, model, budget, remaining requests,
  and privacy notice; never credentials.
- `POST /api/ai-feedback/preview`: accepts `attemptId` and returns exactly the
  data for a permitted stored writing attempt, plus its model-bound preview hash.
- `POST /api/ai-feedback`: requires `attemptId`, the fresh `previewSha256`, and
  `consent: true`; returns a validated provisional proposal.
- `POST /api/ai-feedback/approve`: requires a validated `requestId` and
  `confirm: true`; appends provisional feedback idempotently.

No key returns HTTP 501 and a manual-review fallback (plus the Grok handoff in
local mode). Missing consent returns 400, stale previews 409, exhausted daily
limits 429, and invalid provider output 502. Invalid proposals are never saved as
feedback. The hosted AI route permits the provider timeout; the coordinator must
raise the hosting function duration separately before enabling it. This change
does not edit deployment configuration, provision credentials, publish, or deploy.

## Verification boundaries

Unit and integration tests inject mock HTTP; no test is permitted to call the
real provider. Coverage includes request minimality, strict output validation,
quote matching, costs and day boundaries, consent and preview checks, budgets,
owner isolation, approval idempotency, no evidence promotion, and key redaction.
The Playwright suite mocks `/api` routes for local/hosted availability, preview,
per-request consent, resets, privacy wording, and unofficial proposal rendering.

Dependency-free checks run with
`node --experimental-strip-types --test tests/ai-pure.test.mjs`: all six passed.
They cover configuration, cost arithmetic, New York day boundaries, static
migration safeguards, and client credential absence without applying SQL.
Node's TypeScript syntax checks and `git diff --check` also passed; syntax checking
does not substitute for TypeScript typechecking. GitNexus upstream queries could
not find these application symbols in the parent Projects index (risk unknown),
and `detect_changes` could not resolve an index for this worktree. Local callers
were inspected instead. The bridge owns staging and committing this change.

Dependencies were absent in the sandbox and installing packages, browsers, or
models was not authorized. Dependency-backed checks, browser runs, and database
execution therefore require later authorized verification. Do not treat authored
tests as a passing test run. Real Postgres tests require a dedicated disposable
Postgres 17+ cluster, never a shared or live database.
