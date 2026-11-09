// Dependency-free SQL invariants; actual SQL behavior is tested by auth.pg.test.ts.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const source = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('auth migration retains operator ownership, forced definer RLS and function-only app access', () => {
  const migration = source('apps/server/src/postgres/migrations/004-sei-auth.sql');
  const previous = source('apps/server/src/postgres/migrations/003-sei-ai-feedback.sql');
  const ownership = /DO \$ownership\$[\s\S]*?\$ownership\$;/;
  assert.equal(migration.match(ownership)?.[0], previous.match(ownership)?.[0]);
  assert.match(migration, /^-- OPERATOR ONLY\./);
  assert.match(migration, /\bBEGIN;/);
  assert.match(migration, /COMMIT;\s*$/);
  for (const table of ['accounts', 'auth_sessions']) assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS sei\\.${table} \\(`));
  assert.match(migration, /ENABLE ROW LEVEL SECURITY/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /REVOKE ALL ON TABLE sei\.%I FROM PUBLIC, sei_app/);
  assert.match(migration, /CREATE POLICY sei_auth_definer ON sei\.%I FOR ALL TO %I USING \(true\) WITH CHECK \(true\)/);
  assert.match(migration, /table_name, current_user/);
  assert.doesNotMatch(migration, /GRANT (?:SELECT|INSERT|UPDATE|DELETE|ALL|TRUNCATE)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION %s FROM PUBLIC, sei_app/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION %s TO sei_app/);
  assert.match(migration, /ARRAY\['anon', 'authenticated'\]/);
  assert.equal((migration.match(/SECURITY DEFINER SET search_path = pg_catalog/g) ?? []).length, 7);
  assert.doesNotMatch(migration, /CREATE OR REPLACE FUNCTION sei\.request_owner_id/);
  assert.match(migration, /LOCK TABLE sei\.accounts IN EXCLUSIVE MODE/);
  assert.match(migration, /new_owner := p_first_owner/);
  assert.match(migration, /new_owner := pg_catalog\.gen_random_uuid\(\)/);
  assert.match(migration, /ERRCODE = 'P0001'/);
  assert.match(migration, /failed_logins \+ 1 >= 10/);
  assert.match(migration, /INTERVAL '15 minutes'/);
  assert.match(migration, /INTERVAL '30 days'/);
  assert.match(migration, /LIMIT 100/);
  assert.match(migration, /s\.revoked_at IS NULL AND s\.expires_at > p_now/);
  assert.match(source('apps/server/postgres/harness.ts'), /migration\('004-sei-auth\.sql'\)/);
});
