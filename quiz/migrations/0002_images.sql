-- Phase 3: question pictures (PROTOCOL.md §14). Additive only, like 0001.
-- The pictures themselves are in the R2 bucket; these tables say which exist
-- and which quizzes use them, so unused pictures can be removed.

-- One row per picture in the bucket. `key` is the bucket key: the SHA-256 of
-- the file and its extension, so the same file is stored once. `unused_since`
-- is when no quiz (live or in the Trash) was found using it; NULL while one
-- does. A picture unused for 8 days is deleted: longer than the 7 days a
-- Time Travel restore can go back, so a restored quiz never lacks its picture.
CREATE TABLE IF NOT EXISTS images (
  key TEXT PRIMARY KEY,
  library_id TEXT NOT NULL DEFAULT 'main',
  bytes INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  unused_since INTEGER
);
CREATE INDEX IF NOT EXISTS images_by_use ON images (library_id, unused_since);

-- Which quiz uses which picture, rewritten each time a quiz is saved.
CREATE TABLE IF NOT EXISTS quiz_images (
  quiz_id TEXT NOT NULL,
  key TEXT NOT NULL,
  PRIMARY KEY (quiz_id, key)
);
CREATE INDEX IF NOT EXISTS quiz_images_by_key ON quiz_images (key);

-- When unused pictures were last looked for (at most hourly, when the list is read).
ALTER TABLE library ADD COLUMN images_checked_at INTEGER;
