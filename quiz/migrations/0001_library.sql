-- Phase 2: the synced quiz library (PROTOCOL.md §12). Additive only: a later
-- migration may add tables, nullable columns or columns with defaults, never
-- drop or rename, so the previous Worker version keeps working after a rollback.

-- One row per quiz. `body` is the quiz exactly as the host page saved it
-- (JSON text: title, questions and any field this server does not know).
-- `version` goes up by one on every change; a write must name the version it
-- was based on. Deleted quizzes keep their row (`deleted_at`) for 30 days.
CREATE TABLE IF NOT EXISTS quizzes (
  id TEXT PRIMARY KEY,
  library_id TEXT NOT NULL DEFAULT 'main',
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  schema INTEGER NOT NULL DEFAULT 1,
  question_count INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS quizzes_by_library ON quizzes (library_id, deleted_at, updated_at);

-- One row per library. `generation` changes only when the database is restored
-- from a backup, so pages know to drop their cached copies (PROTOCOL.md §12).
CREATE TABLE IF NOT EXISTS library (
  id TEXT PRIMARY KEY,
  generation INTEGER NOT NULL
);
INSERT OR IGNORE INTO library (id, generation) VALUES ('main', 1);
