-- The 10,000-row local D1 benchmark reduced this lookup from 12,500 rows
-- read to one; updating completed metadata adds one index write.
CREATE INDEX idx_jobs_reusable_media ON jobs (
  telegram_user_id, telegram_chat_id, source_url_hash, requested_mode,
  requested_quality, processing_policy_version, completed_at DESC, updated_at DESC
)
WHERE status = 'completed' AND cache_valid = 1 AND result_message_id IS NOT NULL;
