-- OPERATOR ONLY. Run as postgres after 000.
-- This migration owns only sei objects and never exposes sei to the Data API.
BEGIN;
CREATE SCHEMA IF NOT EXISTS sei;
REVOKE ALL ON SCHEMA sei FROM PUBLIC, sei_app;

-- Ownership bypasses privilege revocation (and permits disabling RLS/triggers).
-- Refuse to adopt objects owned by an app/API role; an operator must review them.
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

-- Operator-owned; the guard above also covers this function on reruns.
-- Only the server sets this transaction-local claim in withOwnerTransaction.
CREATE OR REPLACE FUNCTION sei.request_owner_id() RETURNS uuid
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
REVOKE ALL ON FUNCTION sei.request_owner_id() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sei.request_owner_id() TO sei_app;

CREATE TABLE IF NOT EXISTS sei.native_scheduler_configs (
  owner_id uuid NOT NULL,
  hash text NOT NULL CHECK (hash ~ '^[0-9a-f]{64}$'),
  entity_json jsonb NOT NULL CHECK (jsonb_typeof(entity_json) = 'object'),
  PRIMARY KEY (owner_id, hash)
);

CREATE TABLE IF NOT EXISTS sei.native_card_versions (
  owner_id uuid NOT NULL,
  card_id text NOT NULL CHECK (length(card_id) BETWEEN 1 AND 200),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  snapshot_json jsonb NOT NULL CHECK (jsonb_typeof(snapshot_json) = 'object'),
  PRIMARY KEY (owner_id, card_id, fingerprint)
);

CREATE TABLE IF NOT EXISTS sei.native_flashcard_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  owner_id uuid NOT NULL,
  id uuid NOT NULL,
  event_version integer NOT NULL CHECK (event_version = 1),
  client_event_id uuid,
  request_hash text CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  card_id text NOT NULL CHECK (length(card_id) BETWEEN 1 AND 200),
  projection_version integer NOT NULL CHECK (projection_version > 0),
  kind text NOT NULL CHECK (kind IN ('init', 'review', 'control')),
  config_hash text NOT NULL,
  fingerprint text NOT NULL,
  server_now timestamptz NOT NULL,
  event_hash text NOT NULL CHECK (event_hash ~ '^[0-9a-f]{64}$'),
  entity_json jsonb NOT NULL CHECK (jsonb_typeof(entity_json) = 'object'),
  PRIMARY KEY (owner_id, id),
  UNIQUE (owner_id, client_event_id),
  UNIQUE (owner_id, card_id, projection_version),
  FOREIGN KEY (owner_id, config_hash) REFERENCES sei.native_scheduler_configs(owner_id, hash),
  FOREIGN KEY (owner_id, card_id, fingerprint) REFERENCES sei.native_card_versions(owner_id, card_id, fingerprint),
  CHECK ((kind = 'init' AND client_event_id IS NULL AND request_hash IS NULL AND projection_version = 1)
    OR (kind IN ('review', 'control') AND client_event_id IS NOT NULL AND request_hash IS NOT NULL AND projection_version > 1))
);

CREATE TABLE IF NOT EXISTS sei.native_flashcard_projections (
  owner_id uuid NOT NULL,
  card_id text NOT NULL CHECK (length(card_id) BETWEEN 1 AND 200),
  version integer NOT NULL CHECK (version > 0),
  entity_json jsonb NOT NULL CHECK (jsonb_typeof(entity_json) = 'object'),
  PRIMARY KEY (owner_id, card_id),
  FOREIGN KEY (owner_id, card_id, version) REFERENCES sei.native_flashcard_events(owner_id, card_id, projection_version)
);

CREATE OR REPLACE FUNCTION sei.reject_immutable_mutation() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $immutable$
BEGIN
  RAISE EXCEPTION 'SEI native history is append-only' USING ERRCODE = '55000';
END
$immutable$;
REVOKE ALL ON FUNCTION sei.reject_immutable_mutation() FROM PUBLIC;

-- Only named sei tables are touched. Recreating named policies/triggers is safe.
DO $security$
DECLARE
  table_name text;
  role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['native_scheduler_configs', 'native_card_versions',
    'native_flashcard_events', 'native_flashcard_projections']
  LOOP
    EXECUTE format('ALTER TABLE sei.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE sei.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS sei_owner ON sei.%I', table_name);
    EXECUTE format('CREATE POLICY sei_owner ON sei.%I TO sei_app USING (owner_id = sei.request_owner_id()) WITH CHECK (owner_id = sei.request_owner_id())', table_name);
    EXECUTE format('REVOKE ALL ON TABLE sei.%I FROM PUBLIC, sei_app', table_name);
    IF table_name <> 'native_flashcard_projections' THEN
      EXECUTE format('DROP TRIGGER IF EXISTS sei_append_only ON sei.%I', table_name);
      EXECUTE format('CREATE TRIGGER sei_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON sei.%I FOR EACH STATEMENT EXECUTE FUNCTION sei.reject_immutable_mutation()', table_name);
      EXECUTE format('GRANT SELECT, INSERT ON TABLE sei.%I TO sei_app', table_name);
    ELSE
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE sei.%I TO sei_app', table_name);
    END IF;
  END LOOP;
  -- These roles exist in Supabase, but need not exist in an isolated test database.
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA sei FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA sei FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA sei FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA sei FROM %I', role_name);
    END IF;
  END LOOP;
END
$security$;
GRANT USAGE ON SCHEMA sei TO sei_app;
REVOKE ALL ON SEQUENCE sei.native_flashcard_events_sequence_seq FROM PUBLIC, sei_app;
GRANT USAGE ON SEQUENCE sei.native_flashcard_events_sequence_seq TO sei_app;
COMMIT;
