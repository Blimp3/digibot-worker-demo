-- Metadata-only one-shot lookup receipts use the existing seven-day cleanup.
ALTER TABLE processed_updates ADD COLUMN collection_user_id TEXT;
CREATE INDEX processed_updates_collection_rate ON processed_updates(collection_user_id, created_at)
  WHERE collection_user_id IS NOT NULL;
