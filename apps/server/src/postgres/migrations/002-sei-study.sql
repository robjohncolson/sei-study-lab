-- OPERATOR ONLY. Run as postgres after 000 and 001. Supabase supplies auth.uid().
-- Only private sei objects are touched; no Data API or global/Auth changes.
BEGIN;

DO $ownership$
BEGIN
  IF EXISTS (
    SELECT FROM pg_catalog.pg_namespace n JOIN pg_catalog.pg_roles r ON r.oid=n.nspowner
    WHERE n.nspname='sei' AND r.rolname IN ('sei_app', 'anon', 'authenticated')
  ) OR EXISTS (
    SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_catalog.pg_roles r ON r.oid=c.relowner
    WHERE n.nspname='sei' AND r.rolname IN ('sei_app', 'anon', 'authenticated')
  ) OR EXISTS (
    SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
      JOIN pg_catalog.pg_roles r ON r.oid=p.proowner
    WHERE n.nspname='sei' AND r.rolname IN ('sei_app', 'anon', 'authenticated')
  ) THEN
    RAISE EXCEPTION 'sei objects must be owned by an operator, not an app/API role';
  END IF;
END
$ownership$;

CREATE TABLE IF NOT EXISTS sei.task_versions (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id uuid NOT NULL,
  id text NOT NULL CHECK (length(id) BETWEEN 1 AND 200),
  version text NOT NULL,
  entity_json jsonb NOT NULL CHECK (jsonb_typeof(entity_json) = 'object'),
  PRIMARY KEY (owner_id, id, version)
);

CREATE TABLE IF NOT EXISTS sei.attempts (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id uuid NOT NULL,
  id uuid NOT NULL,
  task_id text NOT NULL,
  task_version text NOT NULL,
  parent_attempt_id uuid,
  -- json preserves all JSON string escapes, including U+0000 and lone surrogates
  -- accepted by the SQLite adapter; jsonb would reject those original answers.
  entity_json json NOT NULL CHECK (json_typeof(entity_json) = 'object'),
  PRIMARY KEY (owner_id, id),
  FOREIGN KEY (owner_id, task_id, task_version) REFERENCES sei.task_versions(owner_id, id, version),
  FOREIGN KEY (owner_id, parent_attempt_id) REFERENCES sei.attempts(owner_id, id)
);

CREATE TABLE IF NOT EXISTS sei.judgments (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id uuid NOT NULL,
  id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  supersedes_id uuid,
  entity_json json NOT NULL CHECK (json_typeof(entity_json) = 'object'),
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, id, attempt_id),
  FOREIGN KEY (owner_id, attempt_id) REFERENCES sei.attempts(owner_id, id),
  FOREIGN KEY (owner_id, supersedes_id, attempt_id) REFERENCES sei.judgments(owner_id, id, attempt_id)
);

CREATE TABLE IF NOT EXISTS sei.evidence_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id uuid NOT NULL,
  id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  judgment_id uuid NOT NULL,
  entity_json jsonb NOT NULL CHECK (jsonb_typeof(entity_json) = 'object'),
  PRIMARY KEY (owner_id, id),
  FOREIGN KEY (owner_id, attempt_id) REFERENCES sei.attempts(owner_id, id),
  FOREIGN KEY (owner_id, judgment_id, attempt_id) REFERENCES sei.judgments(owner_id, id, attempt_id)
);

CREATE TABLE IF NOT EXISTS sei.drafts (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id uuid NOT NULL,
  task_id text NOT NULL,
  task_version text NOT NULL,
  answer_json json NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, task_id, task_version),
  FOREIGN KEY (owner_id, task_id, task_version) REFERENCES sei.task_versions(owner_id, id, version)
);

-- 001 provides the operator-owned, append-only trigger function. Reuse it here.
DO $security$
DECLARE
  table_name text;
  role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['task_versions', 'attempts', 'judgments', 'evidence_events', 'drafts'] LOOP
    EXECUTE format('ALTER TABLE sei.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE sei.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS sei_owner ON sei.%I', table_name);
    EXECUTE format('CREATE POLICY sei_owner ON sei.%I TO sei_app USING (owner_id = auth.uid()) WITH CHECK (owner_id = auth.uid())', table_name);
    EXECUTE format('REVOKE ALL ON TABLE sei.%I FROM PUBLIC, sei_app', table_name);
    EXECUTE format('REVOKE ALL ON SEQUENCE sei.%I FROM PUBLIC, sei_app', table_name || '_sequence_seq');
    IF table_name = 'drafts' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE sei.%I TO sei_app', table_name);
    ELSE
      EXECUTE format('DROP TRIGGER IF EXISTS sei_append_only ON sei.%I', table_name);
      EXECUTE format('CREATE TRIGGER sei_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON sei.%I FOR EACH STATEMENT EXECUTE FUNCTION sei.reject_immutable_mutation()', table_name);
      EXECUTE format('GRANT SELECT, INSERT ON TABLE sei.%I TO sei_app', table_name);
    END IF;
    EXECUTE format('GRANT USAGE ON SEQUENCE sei.%I TO sei_app', table_name || '_sequence_seq');
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE sei.%I FROM %I', table_name, role_name);
        EXECUTE format('REVOKE ALL ON SEQUENCE sei.%I FROM %I', table_name || '_sequence_seq', role_name);
      END IF;
    END LOOP;
  END LOOP;
END
$security$;
COMMIT;
