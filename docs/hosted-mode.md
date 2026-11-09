# Hosted flashcard foundation

`STORAGE_MODE` defaults to `sqlite`. The existing local server, SQLite store,
session cookies, CSRF checks, and native scheduler remain the default. Setting
`STORAGE_MODE` to `postgres` selects a separate bearer-authenticated API. Other
values fail startup. No local history is uploaded, copied, or synchronized.

Hosted mode currently supports native flashcards only: explicit initialization,
queue, review, control, history, and health/identity. Attempts, drafts, writing,
imports, exports, handoff, and all other routes return HTTP 501 with
`{"error":"Not yet available in hosted mode"}` after the hosted request guards.
The local browser application has not been converted to hosted login. There is
no model integration, AnkiConnect, telemetry, or readiness promotion from reviews.

## Storage and authorization

`NativeStoragePort` is an asynchronous boundary. `SQLiteNativeStorage` delegates
to the unchanged `NativeStore`. `PostgresNativeStore` stores full configuration,
content, and event JSON under the private `sei` schema. Both use the existing
`native-scheduler.ts` and exactly ts-fsrs 5.4.2, including Manual reset logs with
signed `scheduled_days`. Immutable events retain original responses and receipts;
projections can be rebuilt from validated event replay. GET/HEAD queue reads do
not initialize, repair, or write anything. Initialization is an explicit,
idempotent POST. Client event IDs are unique per owner; conflicting payloads and
stale expected versions return 409. Writes serialize and lock projection rows.

Fastify verifies bearer tokens with `jose.jwtVerify` and the project's Auth JWKS.
Only ES256/RS256, the project issuer, the authenticated audience and role, a valid
expiration/not-before window, and a UUID subject exactly matching `OWNER_USER_ID`
are accepted. A five-second clock tolerance is allowed. Authentication failure is
401; an otherwise valid non-owner is 403. Neither result accesses Postgres.
`user_metadata` and cookies never authorize hosted requests. Host and Origin are
checked against exact allowlists; unsafe methods require an Origin.

Every operation checks out one `pg` client, begins one transaction, and first
sets verified `request.jwt.claims` and `request.jwt.claim.sub` using transaction-local
`set_config`. Queries are unnamed and parameterized for transaction pooling.
The transaction commits or rolls back before releasing the client. Production
connections verify TLS certificates; optional CA text supplies trusted CA certificates. Only
`localhost` and `127.0.0.1` test connections may use plain TCP. Pools default to
one connection, have a five-second idle timeout, and are capped at five.

The `sei_app` role has no superuser, database creation, role creation, replication,
inheritance, or RLS bypass capability. All `sei` tables enable and force RLS with
owner policies using Supabase's `auth.uid()`. The role can select/insert immutable
tables and select/insert/update projections. It cannot delete or truncate them.
Immutable tables also reject UPDATE/DELETE/TRUNCATE through statement triggers.
The migrations never create or alter Supabase's `auth.uid()` or neighbor schemas.
The schema is not exposed through the Data API/PostgREST. No service-role key is
used.

## Environment settings

Keep these settings backend-only in the deployment secret/configuration manager;
do not commit values or use frontend-prefixed environment variables.

| Name | Purpose |
| --- | --- |
| `STORAGE_MODE` | Select `postgres`; omitted means `sqlite` |
| `SEI_DATABASE_URL` | Direct PostgreSQL or transaction-pooler connection as `sei_app` |
| `SUPABASE_URL` | Project HTTPS origin used for issuer and JWKS |
| `OWNER_USER_ID` | Exact UUID of the single authorized Auth user |
| `APP_ORIGINS` | Comma-separated exact permitted web origins |
| `APP_HOSTS` | Comma-separated exact permitted Host headers, including ports when used |
| `SEI_DATABASE_POOL_MAX` | Optional pool limit, default one, maximum five |
| `SEI_DATABASE_CA_PEM` | Optional PEM CA text for verified TLS |
| `SEI_TEST_ADMIN_DATABASE_URL` | Test harness only; disposable Postgres 17 cluster administrator |

All required hosted settings are validated before connections are opened. Error
messages name settings without echoing credentials. Database URLs must specify
the restricted username and database without query options, so URL options cannot
disable certificate verification. Local `SEI_DB_PATH` is not read in hosted mode.

## Operator provisioning, not performed by this change

The existing Supabase project is **curriculum_renderer**, reference
`bzqbhtrurzzavhqbgqrs`. Review these additive scripts before applying them:

1. Run `apps/server/src/postgres/migrations/000-sei-app-role.sql` as `postgres`
   through the SQL editor. It creates a `NOLOGIN` placeholder with connection
   limit five and rejects an unsafe pre-existing role or role memberships.
2. Run `apps/server/src/postgres/migrations/001-sei-hosted.sql` as `postgres`.
   Reruns preserve data and re-establish the named `sei` policies and grants.
3. Set a generated `sei_app` password and enable LOGIN out-of-band. Store it only
   in the backend secret manager. Never grant `sei_app` to another role. Use the
   Supabase transaction pooler on port **6543**, with username
   **sei_app.bzqbhtrurzzavhqbgqrs**. Retain certificate verification.
4. Keep `sei` private: do **not** add it to the Data API exposed schemas. Do not
   alter `public`, `auth`, `storage`, `lesson_planning`, or their grants/policies.
5. Create the single intended owner Auth user through an authorized operator
   action and configure `OWNER_USER_ID`. Do not change Auth signup, providers,
   or global settings. Add only the required redirect URLs; preserve existing
   redirect entries. Browser login and token refresh remain future work.

`createHostedSeiServer(options)` supports injected pools, local JWKS verification,
catalogs, and clocks for isolated tests. Injected pools remain caller-owned.
`createHostedHandler(options)` exports a plain Node request handler with a close
method for later hosting integration. `main.ts` continues to bind only loopback.
Vercel entry routing/build configuration and packaging the catalog remain pending:
the protected deployment paths require the coordinator. Nothing was deployed.

## Verification and boundaries

`npm test` excludes `apps/server/postgres/**`. Run `npm run test:postgres`
separately against an explicitly provisioned disposable Postgres 17 cluster. It
fails when `SEI_TEST_ADMIN_DATABASE_URL` is missing. The administrator must be able
to create/drop a disposable database and the test-owned cluster role. The harness
refuses an existing `sei_app` role rather than changing its password; do not point
it at Supabase or any shared/live cluster. It generates a password in memory,
creates synthetic neighbor data and a test-only `auth.uid()`, applies migrations
twice, connects as `sei_app`, and tears down its database and role. It exercises
RLS, neighbor denial, append-only restrictions, transaction-local claims, HTTP
authentication, concurrency, idempotency, restarts, read-only queues, and parity
with an in-memory SQLite adapter.

This sandbox has Node 22.17.1 but no installed application dependencies. No npm
installation, network request, real database DDL, browser download, or private
runtime access was performed. Dependency-backed typecheck, lint, unit/integration,
browser, build, and real-Postgres execution remain coordinator checks. Existing
189 unit/integration and 26 browser tests were left unchanged; those counts are
the supplied baseline, not a claim that this change passed them here.

The supplied dependency-only patches were verified with SHA256 before adding
the separately required `test:postgres` script:

- `package.json`: `35048c4fd505c8d25b370d4908928ad07a14116b7d21c9e2859d631844ae572f`
- `package-lock.json`: `fdb13e1e7ccb71df70f106e3984b8c5ac5f0750772aea7394de0edb940bf84d1`

The final lockfile retains that exact hash. The additional test script changes
the final manifest hash to
`e0b22be62192dc70e069f75184ae05f15626c562c2b27a25b94bbc4210a4681a`.
Dependency-free configuration smoke checks, syntax parsing of all 14 changed/new
TypeScript files, relative import resolution, and `git diff --check` passed.
Twenty-five existing SQLite/domain/test files were compared with the base and
remain byte-identical. The modified-path audit found no protected files.

GitNexus's parent Projects index cannot resolve these application symbols.
The required `detect_changes --scope all --repo Projects` was attempted before
commit but its indexed directory failed with "Not a git repository". It cannot
provide a meaningful risk rating here; local caller/file-scope inspection was
used, and the coordinator's runtime checks are still required.
