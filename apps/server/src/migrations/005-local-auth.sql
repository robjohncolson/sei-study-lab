-- Local accounts gate a single learner's history; they do not partition study data.
-- Applied only by the existing SQLite schema_migrations mechanism.
CREATE TABLE IF NOT EXISTS accounts (
  owner_id TEXT PRIMARY KEY NOT NULL,
  username TEXT NOT NULL UNIQUE CHECK (
    length(username) BETWEEN 3 AND 32
    AND username = lower(username)
    AND substr(username, 1, 1) GLOB '[a-z0-9]'
    AND username NOT GLOB '*[^a-z0-9._-]*'
  ),
  password_hash TEXT NOT NULL CHECK (substr(password_hash, 1, 7) = 'scrypt$'),
  failed_logins INTEGER NOT NULL DEFAULT 0 CHECK (failed_logins >= 0),
  locked_until TEXT,
  created_at TEXT NOT NULL,
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY NOT NULL CHECK (
    length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  owner_id TEXT NOT NULL REFERENCES accounts(owner_id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS auth_sessions_owner ON auth_sessions(owner_id);
