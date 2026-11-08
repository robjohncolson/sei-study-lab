ALTER TABLE drafts RENAME TO drafts_legacy_v1;
CREATE TABLE drafts (
  task_id TEXT NOT NULL,
  task_version TEXT NOT NULL,
  answer_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(task_id,task_version),
  FOREIGN KEY(task_id,task_version) REFERENCES tasks(id,version)
);
INSERT INTO drafts(task_id,task_version,answer_json,updated_at)
  SELECT task_id,task_version,answer_json,updated_at FROM drafts_legacy_v1;
CREATE TRIGGER drafts_legacy_v1_no_update BEFORE UPDATE ON drafts_legacy_v1
BEGIN SELECT RAISE(ABORT,'Preserved pre-migration draft'); END;
CREATE TRIGGER drafts_legacy_v1_no_delete BEFORE DELETE ON drafts_legacy_v1
BEGIN SELECT RAISE(ABORT,'Preserved pre-migration draft'); END;
