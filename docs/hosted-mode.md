# Public hosted study app

`STORAGE_MODE` defaults to `sqlite`. The local server retains SQLite storage,
loopback binding, cookies, CSRF checks, and its existing workflows. Explicit
`STORAGE_MODE=postgres` requires `HOSTED_AUTH_MODE=public` or `supabase-jwt`, with
no authentication default. Invalid hosted configuration fails before connecting.

**Public mode means anyone with the URL can read and write this study history.**
There is no login or individual visitor account. All visitors share the single
server-configured `PUBLIC_OWNER_ID`. This UUID is a storage namespace, not a secret
or access credential; it does not require a Supabase Auth user. Changing it selects
a separate history. The hosted copy starts empty. No local history is uploaded,
copied, or synchronized.

## Everyday routes and shared behavior

Hosted mode serves session metadata, bundled catalog, study state, attempts,
versioned drafts, Anki TSV, and native flashcard queue/initialization/reviews/
controls/history. Practice, writing, coverage, planning, and saved responses use
the same state shape as the local app. `/api/export`, `/api/import*`,
`/api/handoff`, and `/api/proposals/*` still return HTTP 501. Exchange shows
“Not available in the hosted copy; use the local app” and retains Anki download.

`study-logic.ts` contains pure task lookup, submission validation, bounded scoring,
policy-v2 evidence derivation, writing mentor identity/five-part checks, draft
validation, and state shaping. Both `SeiStore` and `PostgresStudyStore` use it.
Original answer strings remain exact; open writing remains pending review.
Drafts and hinted/assisted practice never become independent evidence. No
automatic action counts as human review.

Hosted attempts use the server-derived UTC-day session label `hosted-YYYY-MM-DD`.
It is descriptive only: eligibility uses persisted attempts, exposure groups,
retest timing, and assistance through `getAttemptEligibility`, never session IDs
or client-supplied owners. A transaction-local owner lock serializes study work.
One transaction saves the attempt, judgment, and evidence; failure rolls it all
back. Bundled tasks are inserted if absent per owner; conflicting entities with
the same ID/version fail. State includes older `sei.task_versions`. Reading study
state/drafts can seed new bundled versions; native queue GET/HEAD stays read-only.

Native flashcards still use the shared scheduler and ts-fsrs 5.4.2, immutable
reviews, per-owner client-event idempotency, and replayable projections. Reviews
do not establish readiness or transfer evidence. No models, AnkiConnect,
telemetry, external assets, or automatic history transfers are introduced.

## Request and database boundaries

Public mode synthesizes exactly `{sub: PUBLIC_OWNER_ID, role: 'authenticated'}`
on the server. Bodies, queries, cookies, bearer tokens, and headers cannot select
an owner. It never creates a JWKS client. `supabase-jwt` retains existing `jose`
verification: ES256/RS256, configured project issuer, authenticated audience and
role, expiration/not-before with five-second tolerance, and UUID subject matching
`OWNER_USER_ID`. Invalid tokens return 401; a valid non-owner gets 403. This
preserves the bearer API; browser login/refresh UI remains outside this slice.

Both modes require exact `APP_HOSTS` and `APP_ORIGINS` allowlists. Unsafe methods
require a trusted Origin and `x-csrf-token` matching `GET /api/session`. That
stateless value is `hosted-origin-checked`: the custom header forces a browser
CORS preflight that the server never approves. No CORS headers or hosted cookies
are set. This guards browser cross-origin writes; it is not authentication for
the deliberately public copy. Session metadata includes `storageMode: 'postgres'`
and `authMode`, enabling accurate hosted/public UI labels. Internal database and
configuration errors are not echoed in responses.

All DB work runs in `withOwnerTransaction`: BEGIN, set `request.jwt.claims` and
`request.jwt.claim.sub` transaction-locally, parameterized unnamed queries, then
COMMIT or ROLLBACK before releasing the client. Remote TLS verifies certificates;
optional CA text supplies trust. Only explicit localhost tests allow plain TCP.
Pools default to one connection and are capped at five.

`sei_app` cannot bypass RLS or create roles/databases and has no superuser,
inheritance, or replication capability. All tables enable and force RLS with
owner policies using `auth.uid()`. Migration 002 adds full entity JSON and
owner-scoped foreign keys in `task_versions`, `attempts`, `judgments`, and
`evidence_events`. These are append-only with SELECT/INSERT only. Drafts also
permit UPDATE, as native projections do in 001. No DELETE/TRUNCATE or
PUBLIC/anon/authenticated grants are added. Ownership guards refuse app/API-owned
objects. The private `sei` schema is never exposed in the Data API.

User answer-bearing columns use PostgreSQL `json` so escaped U+0000 and lone
surrogates accepted by SQLite remain intact; bundled tasks and evidence use
`jsonb`. These choices do not change append-only or owner boundaries.

## Exact environment settings

Keep these backend-only in deployment configuration, never frontend-prefixed or
committed. Public mode requires:

```text
STORAGE_MODE=postgres
HOSTED_AUTH_MODE=public
PUBLIC_OWNER_ID=<uuid>
SEI_DATABASE_URL=postgresql://sei_app.bzqbhtrurzzavhqbgqrs:<url-encoded-password>@<transaction-pooler-host>:6543/postgres
APP_ORIGINS=https://<deployment-host>
APP_HOSTS=<deployment-host>
```

`SUPABASE_URL` and `OWNER_USER_ID` are neither required nor used in public mode.
The existing JWT API mode instead requires:

```text
STORAGE_MODE=postgres
HOSTED_AUTH_MODE=supabase-jwt
SUPABASE_URL=https://bzqbhtrurzzavhqbgqrs.supabase.co
OWNER_USER_ID=<authorized-auth-user-uuid>
SEI_DATABASE_URL=postgresql://sei_app.bzqbhtrurzzavhqbgqrs:<url-encoded-password>@<transaction-pooler-host>:6543/postgres
APP_ORIGINS=https://<deployment-host>
APP_HOSTS=<deployment-host>
```

Optional in both modes:

```text
SEI_DATABASE_POOL_MAX=1
SEI_DATABASE_CA_PEM=<Supabase root CA PEM if Node trust store fails>
```

Multiple exact Hosts/Origins may be comma-separated; include ports when used.
Database URLs must name `sei_app` or its pooler user and a database, with no query
options. Do not disable TLS verification. Local `SEI_DB_PATH` is unused. Test-only
`SEI_TEST_ADMIN_DATABASE_URL` is never a deployment setting.

## Coordinator provisioning and Vercel handoff

No provisioning or deployment was performed here. For the existing Supabase
**curriculum_renderer** project, ref **bzqbhtrurzzavhqbgqrs**:

1. Review and run `apps/server/src/postgres/migrations/000-sei-app-role.sql` as
   `postgres` through the Supabase SQL editor.
2. Run `001-sei-hosted.sql`, then `002-sei-study.sql`, from that directory as
   `postgres`. Reruns preserve data and restore named policies/triggers/grants.
   These are operator scripts, never startup migrations.
3. Set `sei_app LOGIN` and a generated password out-of-band. Use transaction
   pooler port **6543**, username **sei_app.bzqbhtrurzzavhqbgqrs**, with verified
   TLS. Keep the connection string backend-only; never grant role membership.
4. Never expose `sei` in Data API schemas. Do not change Auth signup/providers,
   global settings, or `public`, `auth`, `storage`, `lesson_planning` objects or
   grants. Public mode requires a chosen UUID, with no Auth account changes.
5. Set the exact environment/Host/Origin above. Start empty; no local history upload.

The coordinator must create this exact **vercel.json** (protected in this slice):

```json
{
  "framework": null,
  "buildCommand": "vite build --config apps/web/vite.config.ts",
  "outputDirectory": "dist/web",
  "installCommand": "npm ci --ignore-scripts",
  "rewrites": [{ "source": "/api/:path*", "destination": "/api/[...path]" }],
  "functions": { "api/[...path].ts": { "maxDuration": 15 } }
}
```

Set the Vercel project Node.js version to **22.x**; the package's
`engines: ">=22.17.0"` otherwise selects the newest runtime. No `build:web` script
or package manifest change is needed. Dependencies stay exactly as supplied,
including pg 8.23.1 and jose 6.2.16.

`api/[...path].ts` is an ESM Node function that lazily caches one
`createHostedHandler` promise per warm instance, forwards requests, and never
listens. Importing it creates no app, pool, or connection. The hosted app uses a
static JSON import of `content/catalog.json` for file tracing. Relative imports
use `.js` extensions to TypeScript sources with no aliases; tsconfig includes
`api`. `main.ts` retains loopback binding. Injected test pools remain caller-owned.

## Verification in this slice

Required base: `7fb5c93cce813be90fca509d77b7d54bff211e92`. Available runtime:
Node 22.17.1, with experimental built-in SQLite. Dependencies are absent, and
installation/network/database actions are prohibited. `npm run typecheck`,
`npm run lint`, and `npm test` were attempted but could not start because
`tsc`, `eslint`, and `vitest` are missing. No passing dependency-backed check is
claimed. Build, content validation, browser tests, and real Postgres execution
remain coordinator checks after an authorized install.

Default tests add config/public owner-spoof guards, shared-logic parity, and
side-effect-free entry import. The separate Postgres suite extends the original
eleven tests with public HTTP study workflows, SQLite state/eligibility parity,
writing, versioned drafts, rollback/concurrency, isolation, immutable mutation
rejection, and neighbor denial. The harness applies 000, 001, and 002 twice.
Run `npm run test:postgres` only against an explicitly provisioned disposable
Postgres 17+ cluster: it creates/drops a synthetic database and role and refuses
an existing `sei_app`. Never point it at Supabase or a shared/live DB. The supplied
239 default tests and eleven Postgres tests are baseline counts, not results here.

Dependency-free configuration, syntax/import tracing, scope checks, and
`git diff --check` are recorded in the implementation status. GitNexus's parent
Projects index cannot resolve these application symbols (UNKNOWN risk); local
callers and repository diff provide scope checks. No protected paths, dependency
manifests, learner data, or local history were changed.
