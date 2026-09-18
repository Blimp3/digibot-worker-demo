-- Captions are transcript documents prepared on the source-download lane.
-- Preserve existing operation values and historical Whisper jobs.
ALTER TABLE jobs ADD COLUMN transcript_method TEXT NOT NULL DEFAULT 'whisper'
  CHECK (transcript_method IN ('whisper', 'captions'));

ALTER TABLE jobs ADD COLUMN caption_language TEXT
  CHECK (caption_language IS NULL OR length(caption_language) BETWEEN 2 AND 35);

-- Search retains only admission/replay metadata on the existing receipt ledger.
-- No file IDs, document contents, queries, or matches are stored.
ALTER TABLE processed_updates ADD COLUMN search_user_id TEXT;

CREATE INDEX idx_processed_updates_search_user_created
  ON processed_updates (search_user_id, created_at)
  WHERE search_user_id IS NOT NULL;
