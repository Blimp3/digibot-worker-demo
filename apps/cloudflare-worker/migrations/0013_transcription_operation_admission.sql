-- Keep transcript requests in the same durable job/receipt/recovery ledger
-- while isolating their active slot from normal source downloads.
ALTER TABLE jobs ADD COLUMN requested_operation TEXT NOT NULL DEFAULT 'download'
  CHECK (requested_operation IN ('download', 'transcript'));

ALTER TABLE jobs ADD COLUMN deadline_at INTEGER
  CHECK (deadline_at IS NULL OR deadline_at > 0);

ALTER TABLE active_job_admissions ADD COLUMN lane TEXT NOT NULL DEFAULT 'source'
  CHECK (lane IN ('source', 'transcript'));

CREATE INDEX IF NOT EXISTS idx_active_job_admissions_lane_created
  ON active_job_admissions (lane, created_at);

DROP INDEX IF EXISTS idx_jobs_reusable_media;
CREATE INDEX idx_jobs_reusable_media ON jobs (
  telegram_user_id, telegram_chat_id, source_url_hash, requested_mode,
  requested_operation, requested_quality, requested_start_seconds, requested_end_seconds,
  processing_policy_version, completed_at DESC, updated_at DESC
)
WHERE status = 'completed' AND requested_operation = 'download'
  AND cache_valid = 1 AND result_message_id IS NOT NULL;
