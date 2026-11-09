-- OPERATOR ONLY. Run as postgres after 000, 001, 002 and 003.
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

CREATE TABLE IF NOT EXISTS sei.accounts (
  owner_id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE CHECK (pg_catalog.length(username) BETWEEN 3 AND 32
    AND username = pg_catalog.lower(username) AND username ~ '^[a-z0-9][a-z0-9._-]{2,31}$'),
  password_hash text NOT NULL CHECK (pg_catalog.left(password_hash, 7) = 'scrypt$'),
  failed_logins int NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until timestamptz,
  created_at timestamptz NOT NULL,
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS sei.auth_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  owner_id uuid NOT NULL REFERENCES sei.accounts(owner_id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS auth_sessions_owner_expiry ON sei.auth_sessions(owner_id, expires_at);

DO $security$
DECLARE
  table_name text;
  role_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['accounts', 'auth_sessions'] LOOP
    EXECUTE pg_catalog.format('ALTER TABLE sei.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE pg_catalog.format('ALTER TABLE sei.%I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE sei.%I FROM PUBLIC, sei_app', table_name);
    EXECUTE pg_catalog.format('DROP POLICY IF EXISTS sei_auth_definer ON sei.%I', table_name);
    EXECUTE pg_catalog.format('CREATE POLICY sei_auth_definer ON sei.%I FOR ALL TO %I USING (true) WITH CHECK (true)', table_name, current_user);
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON TABLE sei.%I FROM %I', table_name, role_name);
      END IF;
    END LOOP;
  END LOOP;
END
$security$;

-- These narrowly scoped functions are the app role's only auth table access.
-- They deliberately do not read or modify request_owner_id or study claims.
CREATE OR REPLACE FUNCTION sei.auth_register(
  p_username text, p_password_hash text, p_first_owner uuid, p_allow_open boolean, p_now timestamptz
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  new_owner uuid;
BEGIN
  LOCK TABLE sei.accounts IN EXCLUSIVE MODE;
  IF NOT EXISTS (SELECT FROM sei.accounts) THEN
    new_owner := p_first_owner;
  ELSIF p_allow_open THEN
    new_owner := pg_catalog.gen_random_uuid();
  ELSE
    RAISE EXCEPTION 'signup closed' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO sei.accounts(owner_id, username, password_hash, created_at)
    VALUES(new_owner, p_username, p_password_hash, p_now);
  RETURN new_owner;
END
$$;

CREATE OR REPLACE FUNCTION sei.auth_login_lookup(p_username text, p_now timestamptz)
RETURNS TABLE(owner_id uuid, password_hash text, locked boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT a.owner_id, a.password_hash, COALESCE(a.locked_until > p_now, false)
    FROM sei.accounts AS a WHERE a.username = p_username
$$;

CREATE OR REPLACE FUNCTION sei.auth_login_result(p_owner uuid, p_success boolean, p_now timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF p_success THEN
    UPDATE sei.accounts SET failed_logins = 0, locked_until = NULL, last_login_at = p_now
      WHERE owner_id = p_owner AND (locked_until IS NULL OR locked_until <= p_now);
  ELSE
    UPDATE sei.accounts SET
      locked_until = CASE WHEN failed_logins + 1 >= 10 THEN p_now + INTERVAL '15 minutes' ELSE locked_until END,
      failed_logins = CASE WHEN failed_logins + 1 >= 10 THEN 0 ELSE failed_logins + 1 END
      WHERE owner_id = p_owner AND (locked_until IS NULL OR locked_until <= p_now);
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION sei.auth_session_create(p_token_hash text, p_owner uuid, p_now timestamptz, p_expires timestamptz)
RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  DELETE FROM sei.auth_sessions WHERE token_hash IN (
    SELECT s.token_hash FROM sei.auth_sessions AS s WHERE s.owner_id = p_owner
      AND (s.expires_at < p_now - INTERVAL '30 days' OR s.revoked_at < p_now - INTERVAL '30 days')
      ORDER BY s.expires_at, s.token_hash LIMIT 100
  );
  INSERT INTO sei.auth_sessions(token_hash, owner_id, created_at, expires_at)
    VALUES(p_token_hash, p_owner, p_now, p_expires);
END
$$;

CREATE OR REPLACE FUNCTION sei.auth_session_owner(p_token_hash text, p_now timestamptz)
RETURNS TABLE(owner_id uuid, username text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT a.owner_id, a.username FROM sei.auth_sessions AS s
    JOIN sei.accounts AS a ON a.owner_id = s.owner_id
    WHERE s.token_hash = p_token_hash AND s.revoked_at IS NULL AND s.expires_at > p_now
$$;

CREATE OR REPLACE FUNCTION sei.auth_session_revoke(p_token_hash text, p_now timestamptz)
RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $$
  UPDATE sei.auth_sessions SET revoked_at = COALESCE(revoked_at, p_now) WHERE token_hash = p_token_hash
$$;

CREATE OR REPLACE FUNCTION sei.auth_signup_open(p_allow_open boolean) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog AS $$
  SELECT NOT EXISTS (SELECT FROM sei.accounts) OR p_allow_open
$$;

DO $functions$
DECLARE
  signature text;
  role_name text;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    'sei.auth_register(text,text,uuid,boolean,timestamptz)',
    'sei.auth_login_lookup(text,timestamptz)',
    'sei.auth_login_result(uuid,boolean,timestamptz)',
    'sei.auth_session_create(text,uuid,timestamptz,timestamptz)',
    'sei.auth_session_owner(text,timestamptz)',
    'sei.auth_session_revoke(text,timestamptz)',
    'sei.auth_signup_open(boolean)'
  ] LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, sei_app', signature);
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
        EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I', signature, role_name);
      END IF;
    END LOOP;
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %s TO sei_app', signature);
  END LOOP;
END
$functions$;
COMMIT;
