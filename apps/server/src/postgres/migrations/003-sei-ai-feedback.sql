-- OPERATOR ONLY. Run as postgres after 000, 001 and 002.
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

CREATE TABLE IF NOT EXISTS sei.ai_feedback_usage (
  owner_id uuid NOT NULL,
  day_et date NOT NULL,
  requests int NOT NULL DEFAULT 0 CHECK (requests >= 0),
  reserved_micro_usd bigint NOT NULL DEFAULT 0 CHECK (reserved_micro_usd >= 0),
  spent_micro_usd bigint NOT NULL DEFAULT 0 CHECK (spent_micro_usd >= 0),
  input_tokens bigint NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens bigint NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, day_et)
);

CREATE TABLE IF NOT EXISTS sei.ai_feedback_requests (
  owner_id uuid NOT NULL,
  id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  preview_sha256 text NOT NULL CHECK (length(preview_sha256) = 64),
  model text NOT NULL,
  status text NOT NULL CHECK (status IN ('validated', 'invalid', 'failed')),
  proposal_json jsonb,
  cost_micro_usd bigint NOT NULL CHECK (cost_micro_usd >= 0),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (owner_id, id),
  FOREIGN KEY (owner_id, attempt_id) REFERENCES sei.attempts(owner_id, id),
  CHECK ((status = 'validated' AND proposal_json IS NOT NULL AND jsonb_typeof(proposal_json) = 'object')
    OR (status <> 'validated' AND proposal_json IS NULL))
);

DO $security$
DECLARE
  table_name text;
  role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['ai_feedback_usage', 'ai_feedback_requests'] LOOP
    EXECUTE format('ALTER TABLE sei.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE sei.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS sei_owner ON sei.%I', table_name);
    EXECUTE format('CREATE POLICY sei_owner ON sei.%I TO sei_app USING (owner_id = sei.request_owner_id()) WITH CHECK (owner_id = sei.request_owner_id())', table_name);
    EXECUTE format('REVOKE ALL ON TABLE sei.%I FROM PUBLIC, sei_app', table_name);
    IF table_name = 'ai_feedback_usage' THEN
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE sei.%I TO sei_app', table_name);
    ELSE
      EXECUTE format('DROP TRIGGER IF EXISTS sei_append_only ON sei.%I', table_name);
      EXECUTE format('CREATE TRIGGER sei_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON sei.%I FOR EACH STATEMENT EXECUTE FUNCTION sei.reject_immutable_mutation()', table_name);
      EXECUTE format('GRANT SELECT, INSERT ON TABLE sei.%I TO sei_app', table_name);
    END IF;
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON TABLE sei.%I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
  END LOOP;
END
$security$;
COMMIT;
