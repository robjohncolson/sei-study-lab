-- Applied only by the existing SQLite schema_migrations mechanism.
CREATE TABLE IF NOT EXISTS ai_feedback_usage (
  owner_id TEXT NOT NULL,
  day_et TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0 CHECK(requests >= 0),
  reserved_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK(reserved_micro_usd >= 0),
  spent_micro_usd INTEGER NOT NULL DEFAULT 0 CHECK(spent_micro_usd >= 0),
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK(input_tokens >= 0),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK(output_tokens >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,day_et)
);
CREATE TABLE IF NOT EXISTS ai_feedback_requests (
  owner_id TEXT NOT NULL,
  id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES attempts(id),
  preview_sha256 TEXT NOT NULL CHECK(length(preview_sha256) = 64),
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('validated','invalid','failed')),
  proposal_json TEXT,
  cost_micro_usd INTEGER NOT NULL CHECK(cost_micro_usd >= 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY(owner_id,id),
  CHECK((status = 'validated' AND proposal_json IS NOT NULL) OR (status <> 'validated' AND proposal_json IS NULL))
);
CREATE TRIGGER IF NOT EXISTS ai_feedback_requests_no_update BEFORE UPDATE ON ai_feedback_requests BEGIN SELECT RAISE(ABORT,'Append-only record'); END;
CREATE TRIGGER IF NOT EXISTS ai_feedback_requests_no_delete BEFORE DELETE ON ai_feedback_requests BEGIN SELECT RAISE(ABORT,'Append-only record'); END;
