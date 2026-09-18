-- Keep the requested trim range separate from source and format identity so
-- full and trimmed requests can never reuse one another's Telegram receipt.
ALTER TABLE jobs ADD COLUMN requested_start_seconds INTEGER;
ALTER TABLE jobs ADD COLUMN requested_end_seconds INTEGER CHECK (
  (requested_start_seconds IS NULL AND requested_end_seconds IS NULL)
  OR (
    typeof(requested_start_seconds) = 'integer'
    AND typeof(requested_end_seconds) = 'integer'
    AND requested_start_seconds BETWEEN 0 AND 86400
    AND requested_end_seconds BETWEEN 0 AND 86400
    AND requested_start_seconds < requested_end_seconds
  )
);

DROP INDEX IF EXISTS idx_jobs_reusable_media;
CREATE INDEX idx_jobs_reusable_media ON jobs (
  telegram_user_id, telegram_chat_id, source_url_hash, requested_mode,
  requested_quality, requested_start_seconds, requested_end_seconds,
  processing_policy_version, completed_at DESC, updated_at DESC
)
WHERE status = 'completed' AND cache_valid = 1 AND result_message_id IS NOT NULL;
