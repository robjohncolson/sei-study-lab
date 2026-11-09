CREATE TABLE native_scheduler_configs (
  hash TEXT PRIMARY KEY,
  entity_json TEXT NOT NULL
);
CREATE TABLE native_card_versions (
  card_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  PRIMARY KEY(card_id,fingerprint)
);
CREATE TABLE native_flashcard_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  event_version INTEGER NOT NULL CHECK(event_version=1),
  client_event_id TEXT UNIQUE,
  request_hash TEXT,
  card_id TEXT NOT NULL,
  projection_version INTEGER NOT NULL CHECK(projection_version>=1),
  kind TEXT NOT NULL CHECK(kind IN ('init','review','control')),
  config_hash TEXT NOT NULL REFERENCES native_scheduler_configs(hash),
  fingerprint TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  entity_json TEXT NOT NULL,
  UNIQUE(card_id,projection_version),
  FOREIGN KEY(card_id,fingerprint) REFERENCES native_card_versions(card_id,fingerprint),
  CHECK((kind='init' AND client_event_id IS NULL AND request_hash IS NULL) OR
        (kind<>'init' AND client_event_id IS NOT NULL AND request_hash IS NOT NULL))
);
CREATE TABLE native_flashcard_projections (
  card_id TEXT PRIMARY KEY,
  version INTEGER NOT NULL CHECK(version>=1),
  entity_json TEXT NOT NULL
);
CREATE INDEX native_flashcard_history ON native_flashcard_events(card_id,projection_version);
CREATE TRIGGER native_scheduler_configs_no_update BEFORE UPDATE ON native_scheduler_configs
BEGIN SELECT RAISE(ABORT,'Append-only native scheduler configuration'); END;
CREATE TRIGGER native_scheduler_configs_no_delete BEFORE DELETE ON native_scheduler_configs
BEGIN SELECT RAISE(ABORT,'Append-only native scheduler configuration'); END;
CREATE TRIGGER native_card_versions_no_update BEFORE UPDATE ON native_card_versions
BEGIN SELECT RAISE(ABORT,'Append-only native card version'); END;
CREATE TRIGGER native_card_versions_no_delete BEFORE DELETE ON native_card_versions
BEGIN SELECT RAISE(ABORT,'Append-only native card version'); END;
CREATE TRIGGER native_flashcard_events_no_update BEFORE UPDATE ON native_flashcard_events
BEGIN SELECT RAISE(ABORT,'Append-only native flashcard event'); END;
CREATE TRIGGER native_flashcard_events_no_delete BEFORE DELETE ON native_flashcard_events
BEGIN SELECT RAISE(ABORT,'Append-only native flashcard event'); END;
