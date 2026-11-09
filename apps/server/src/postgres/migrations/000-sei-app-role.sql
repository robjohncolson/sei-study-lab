-- OPERATOR ONLY. Cluster role provisioning; this does not grant role membership.
-- Run as postgres before 001. Set a generated password and LOGIN out-of-band.
-- Re-running preserves an existing login/password and rejects unsafe attributes.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'sei_app') THEN
    CREATE ROLE sei_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOINHERIT NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 5;
  END IF;
  IF EXISTS (
    SELECT FROM pg_catalog.pg_roles WHERE rolname = 'sei_app'
      AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls
        OR rolinherit OR rolconnlimit <> 5)
  ) THEN
    RAISE EXCEPTION 'Existing sei_app role has unsafe attributes; operator review required';
  END IF;
  IF EXISTS (
    SELECT FROM pg_catalog.pg_auth_members AS m
    JOIN pg_catalog.pg_roles AS r ON r.oid = m.member OR r.oid = m.roleid
    WHERE r.rolname = 'sei_app'
  ) THEN
    RAISE EXCEPTION 'sei_app must not have role memberships or member roles';
  END IF;
END
$role$;
