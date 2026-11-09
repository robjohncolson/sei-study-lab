# Hosted study app and accounts

`STORAGE_MODE` defaults to `sqlite`. The local server retains SQLite storage,
loopback binding, cookies, CSRF checks, and its existing workflows. Explicit
`STORAGE_MODE=postgres` requires `HOSTED_AUTH_MODE=public`, `password` or `supabase-jwt`, with
no authentication default. Invalid hosted configuration fails before connecting.

**Public mode means anyone with the URL can read and write this study history.**
There is no login or individual visitor account. All visitors share the single
server-configured `PUBLIC_OWNER_ID`. This UUID is a storage namespace, not a secret
or access credential; it does not require a Supabase Auth user. Changing it selects
a separate history. The hosted copy starts empty. No local history is uploaded,
copied, or synchronized.

## Password sign-in

Password mode uses the site's own username/password accounts. Select `password`
for `HOSTED_AUTH_MODE` and configure the settings listed below after the operator
has applied migration 004. The first visitor can create the first account even
when open registration is disabled. If the site is reachable before you register,
configure `AUTH_SETUP_CODE` so only someone who knows that code can create an
account. The create-account form shows a setup-code field only when required.

**The first account's owner ID is `PUBLIC_OWNER_ID`.** No history is copied or
rewritten: existing append-only attempts, judgments, evidence, drafts, flashcards
and AI requests already belong to that ID. Keep `PUBLIC_OWNER_ID` unchanged when
enabling sign-in for an existing public copy. Later accounts receive new owner
UUIDs and start with empty history. All accounts use the existing owner claim and
RLS policies; no separate study ownership model is introduced.

Leave `AUTH_ALLOW_SIGNUP` unset or false to close registration after the first
account. Setting it true permits further accounts. A configured setup code is
required on every signup, including the first. Usernames are case-insensitive:
3–32 letters, numbers, dots, underscores or hyphens, starting with a letter or
number. Passwords require 10–200 characters and a non-space character, with a
bounded UTF-8 byte length. There is no password-reset or account-recovery flow in
this version; keep your password in your password manager.

Sessions last 30 days. The browser receives an HttpOnly, Secure, SameSite=Lax
`__Host-sei_session` cookie scoped to `/`. HTTP localhost tests use `sei_session`
without Secure only when every allowed origin is an HTTP loopback origin. The
database stores an HMAC of the random session token, never the token itself.
Passwords use salted scrypt. Logout revokes the session and clears the cookie.
Unknown usernames, wrong passwords and locked accounts receive the same error.
Ten failed password checks lock the account for 15 minutes; a per-process rate
limit also slows login and signup attempts.

Only session metadata, authentication routes, the catalog, Anki TSV and health
are public in password mode. All other APIs, including identity, study state,
native flashcard reads and AI status/preview/request/approval, require a valid
session. The existing per-owner daily AI budget therefore applies **per account**.
Signing in on another computer opens that account's hosted study history.

To roll back the login gate, switch `HOSTED_AUTH_MODE` back to `public` while
retaining `PUBLIC_OWNER_ID`. The original owner's history becomes public again;
other accounts' histories remain under their separate owner IDs. Migration 004
and its account/session records can remain in place. Rotating `SEI_SESSION_SECRET`
invalidates existing sessions; the setting must remain consistent across hosted
instances and redeployments for sessions to continue working.

User instructions are in [Accounts](accounts.md).

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

Optional [DeepSeek essay feedback](ai-feedback.md) is available in all hosted
auth modes when configured on the server. Writing requires an exact-data preview
and fresh consent for each request; saving its unofficial proposal is a separate
action. Public visitors share the owner's daily AI budget. The local Grok handoff
is unchanged, and hosted Exchange keeps handoff/proposal sections hidden. Apply
operator migration `003-sei-ai-feedback.sql` after 000–002 before enabling this
feature. Its configuration, privacy notice, reservation accounting and verification
limits are documented in the linked guide. The coordinator must separately raise
the hosting function duration to accommodate the 50-second provider timeout;
deployment configuration is unchanged here.

Native flashcards still use the shared scheduler and ts-fsrs 5.4.2, immutable
reviews, per-owner client-event idempotency, and replayable projections. Reviews
do not establish readiness or transfer evidence. There are no automatic model
calls, AnkiConnect, telemetry, external assets, or automatic history transfers.

## Request and database boundaries

Public mode synthesizes exactly `{sub: PUBLIC_OWNER_ID, role: 'authenticated'}`
on the server. Bodies, queries, cookies, bearer tokens, and headers cannot select
an owner. It never creates a JWKS client. `supabase-jwt` retains existing `jose`
verification: ES256/RS256, configured project issuer, authenticated audience and
role, expiration/not-before with five-second tolerance, and UUID subject matching
`OWNER_USER_ID`. Invalid tokens return 401; a valid non-owner gets 403. This
preserves the bearer API; browser login/refresh UI remains outside this slice.

All modes require exact `APP_HOSTS` and `APP_ORIGINS` allowlists. Unsafe methods
require a trusted Origin and `x-csrf-token` matching `GET /api/session`. That
stateless value is `hosted-origin-checked`: the custom header forces a browser
CORS preflight that the server never approves. No CORS headers are set. Public
and JWT modes do not set hosted cookies; password mode sets the session cookie.
This guards browser cross-origin writes; it is not authentication for
the deliberately public copy. Session metadata includes `storageMode: 'postgres'`
and `authMode`, enabling accurate hosted/public UI labels. Internal database and
configuration errors are not echoed in responses.

Study, native and AI DB work runs in `withOwnerTransaction`: BEGIN, set `request.jwt.claims` and
`request.jwt.claim.sub` transaction-locally, parameterized unnamed queries, then
COMMIT or ROLLBACK before releasing the client. Remote TLS verifies certificates;
optional CA text supplies trust. Only explicit localhost tests allow plain TCP.
Pools default to one connection and are capped at five. Only the server connects
as `sei_app` and sets these claims; clients cannot connect directly as that role
or obtain its credentials. The claims come from the configured public owner,
verified JWT identity or validated password session, never client-supplied owner
fields. Password authentication uses short `sei_app` transactions without owner
claims to call the restricted `sei.auth_*` functions. Only after session lookup
does the server run existing study transactions with that account's owner claim.

`sei_app` cannot bypass RLS or create roles/databases and has no superuser,
inheritance, or replication capability. All study, native and AI tables enable and force RLS with
owner policies using `sei.request_owner_id()`. Migration 001 defines this
operator-owned, stable SQL SECURITY INVOKER helper with `search_path = pg_catalog`.
It reads `nullif(current_setting('request.jwt.claim.sub', true), '')::uuid`;
missing or empty claims produce NULL, so policies return no rows and reject
inserts. The helper reads the server-set claim without verifying identity itself.
PUBLIC execution is revoked, and only `sei_app` is granted EXECUTE. Neither
migration needs access to the `auth` schema or changes to Supabase-managed
privileges. Migration 002 adds full entity JSON and
owner-scoped foreign keys in `task_versions`, `attempts`, `judgments`, and
`evidence_events`. These are append-only with SELECT/INSERT only. Drafts also
permit UPDATE, as native projections do in 001. No DELETE/TRUNCATE or
PUBLIC/anon/authenticated grants are added. Ownership guards refuse app/API-owned
objects, including the owner helper on reruns. The private `sei` schema is never
exposed in the Data API.

Migration 004 adds `sei.accounts` and `sei.auth_sessions`, both with ENABLE and
FORCE RLS. `sei_app` has no direct table access. Only the operator-owned SECURITY
DEFINER functions receive EXECUTE grants; their search path is `pg_catalog` and
their table references are schema-qualified. The operator-only definer policy
allows those functions to work under FORCE RLS. PUBLIC, anon and authenticated
receive no auth table or function grants. `sei.request_owner_id()` is unchanged.

User answer-bearing columns use PostgreSQL `json` so escaped U+0000 and lone
surrogates accepted by SQLite remain intact; bundled tasks and evidence use
`jsonb`. These choices do not change append-only or owner boundaries.

## Exact environment settings

Keep these backend-only in deployment configuration, never frontend-prefixed or
committed. This inventory contains setting names only; supply values privately.

| Setting | Requirement |
| --- | --- |
| `STORAGE_MODE` | All hosted modes |
| `HOSTED_AUTH_MODE` | All hosted modes; no hosted default |
| `SEI_DATABASE_URL` | All hosted modes; application-role connection |
| `APP_ORIGINS` | All hosted modes; exact allowed browser origins |
| `APP_HOSTS` | All hosted modes; exact allowed hosts |
| `PUBLIC_OWNER_ID` | Public and password modes; UUID |
| `SEI_SESSION_SECRET` | Password mode; at least 32 base64url or hex characters |
| `AUTH_ALLOW_SIGNUP` | Optional password mode registration flag; closed after first account by default |
| `AUTH_SETUP_CODE` | Optional password mode signup gate |
| `SUPABASE_URL` | JWT mode only |
| `OWNER_USER_ID` | JWT mode only |
| `SEI_DATABASE_POOL_MAX` | Optional pool connection limit |
| `SEI_DATABASE_CA_PEM` | Optional server CA certificate |

`SUPABASE_URL` and `OWNER_USER_ID` are neither required nor used in public or
password mode. Configuration errors identify the setting, never its contents.

Multiple exact Hosts/Origins may be comma-separated; include ports when used.
Database URLs must name `sei_app` or its pooler user and a database, with no query
options. Do not disable TLS verification. Local `SEI_DB_PATH` is unused. Test-only
`SEI_TEST_ADMIN_DATABASE_URL` is never a deployment setting.

## Coordinator provisioning and Vercel handoff

No provisioning or deployment was performed here. For the existing Supabase
**curriculum_renderer** project, ref **bzqbhtrurzzavhqbgqrs**:

1. Review and run `apps/server/src/postgres/migrations/000-sei-app-role.sql` as
   `postgres` through the Supabase SQL editor.
2. Run `001-sei-hosted.sql`, then `002-sei-study.sql`, then
   `003-sei-ai-feedback.sql`, then `004-sei-auth.sql`, from that directory as
   `postgres`. Reruns preserve data and restore named policies/triggers/grants.
   These are operator scripts, never startup migrations.
3. Set `sei_app LOGIN` and a generated password out-of-band. Use transaction
   pooler port **6543**, username **sei_app.bzqbhtrurzzavhqbgqrs**, with verified
   TLS. Keep the connection string backend-only; never grant role membership.
4. Never expose `sei` in Data API schemas. Do not change Auth signup/providers,
   global settings, or `public`, `auth`, `storage`, `lesson_planning` objects or
   grants. Public mode requires a chosen UUID, with no Auth account changes.
5. Set the exact environment/Host/Origin above. For a new deployment, start empty;
   there is no local history upload. For an existing public deployment, retain
   `PUBLIC_OWNER_ID` and create the first account to keep the existing history.

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

The implementation worktree has Node 22.17.1, with experimental built-in SQLite,
but no `node_modules`. No dependencies or browsers were installed. The attempted
`npm run typecheck`, `npm run lint` and `npm test` commands could not start because
`tsc`, `eslint` and `vitest` are missing. Build and browser execution also require
the existing dependencies; no passing dependency-backed check is claimed here.

The dependency-free command below passed all 16 checks using Node's type
transformer and in-memory SQLite only. It covers crypto, validation, cookies,
config, throttling, local signup/login/logout/lockout/expiry, auth migration
invariants and existing pure AI checks. It does not replace Fastify integration,
real Postgres, TypeScript typechecking or browser execution.

```text
node --experimental-transform-types --test tests/auth-pure.test.mjs tests/auth-migration-pure.test.mjs tests/ai-pure.test.mjs
```

Default tests cover configuration/public owner-spoof guards, shared-logic parity,
and side-effect-free entry import. The separate Postgres suite covers public HTTP
study workflows, SQLite state/eligibility parity,
writing, versioned drafts, rollback/concurrency, isolation, immutable mutation
rejection, and neighbor denial. The harness applies 000–004 twice.
It creates an admin-owned decoy `auth` schema with no functions or PUBLIC/
`sei_app` grants and asserts that `sei_app` has no USAGE there. Existing owner
operations, other-owner isolation, absent-claim read/insert denial, and
transaction-local claim assertions must pass without access to that schema.
Run `npm run test:postgres` only against an explicitly provisioned disposable
Postgres 17+ cluster: it creates/drops a synthetic database and role and refuses
an existing `sei_app`. Never point it at Supabase or a shared/live DB.

GitNexus's parent Projects index cannot resolve these application symbols
(UNKNOWN risk); local callers and repository diff provide scope checks.
`gitnexus detect_changes --scope all --repo Projects` also failed because the
parent indexed location reported “Not a git repository”; it supplied no usable
change analysis. Authentication is treated as a high-risk local change, with an
independent security review and explicit integration coverage. No protected paths, dependency
manifests, learner data, or local history were changed.

The password-auth suite adds real Postgres checks for first-owner inheritance,
separate account histories, function-only auth access, lockout, session expiry,
logout, closed signup and setup-code enforcement. The optional browser suite is
separate from the unchanged SQLite project: run
`node node_modules/@playwright/test/cli.js test --config playwright.hosted.config.ts` after dependencies are
available. It skips cleanly when `SEI_TEST_ADMIN_DATABASE_URL` is absent. When set,
the harness creates an ephemeral database, applies all operator migrations and
serves Vite plus the hosted Fastify app on loopback. It tests signup, signin,
signout, the 40-minute plan, mobile account actions and expired-session UI. No
browser or dependency download is performed by this command.

## Optional local login

`npm run dev` keeps its existing account-free SQLite behavior by default. Set
`LOCAL_AUTH` to password to test login locally, with `SEI_SESSION_SECRET` configured
as above. SQLite migration `005-local-auth.sql` adds the account/session tables.
The first local account can register; `LOCAL_ALLOW_SIGNUP` controls whether more
may register afterward. Local accounts only gate access: **all local accounts
share the single local learner's history**, with no account-based isolation or
cross-computer synchronization. Host, Origin and local session CSRF checks remain
in place.
