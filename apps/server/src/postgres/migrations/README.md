# Private SEI schema provisioning

These are operator scripts, never application startup migrations. Run `000-sei-app-role.sql`, then `001-sei-hosted.sql`, then `002-sei-study.sql`, as `postgres` in the intended project. All can be run again; 000 preserves a configured login/password but refuses unsafe role attributes or memberships. Set the role's password and enable LOGIN out-of-band. There is no password in these files and no role membership grant.

001 refuses existing `sei` objects owned by an app/API role, because ownership can disable RLS and triggers. It removes any schema CREATE grant from `sei_app` before granting USAGE. Every future migration must explicitly revoke public/API privileges on its objects too; schema-local default privileges cannot override PostgreSQL's global defaults.

Production uses Supabase's existing `auth.uid()`. Only the disposable Postgres test harness creates a test substitute. Keep `sei` private and absent from exposed Data API schemas. The app connects directly as `sei_app`, sets verified JWT claims transaction-locally, and has no access grants to neighboring schemas. The migrations never create or change objects in `public`, `auth`, `storage`, or `lesson_planning`.

All nine tables force owner RLS; config, content, task versions, attempts, judgments, and evidence/events additionally reject update, delete, and truncate. Only native projections and study drafts permit UPDATE. Projections can be rebuilt from verified immutable events. The app does not receive DELETE or TRUNCATE privileges. See [hosted mode](../../../../../docs/hosted-mode.md) for public/JWT environments, exact Vercel handoff, and operator setup.
