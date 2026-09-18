-- Existing URL jobs and prompts retain their source kind after migration.
ALTER TABLE jobs ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'url'
  CHECK(source_kind IN ('url', 'telegram_file'));
ALTER TABLE video_quality_prompts ADD COLUMN source_kind TEXT NOT NULL DEFAULT 'url'
  CHECK(source_kind IN ('url', 'telegram_file'));
