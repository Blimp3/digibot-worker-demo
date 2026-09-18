-- Durable admission, dispatch, and delivery state. These tables are
-- additive so the historical 0003-0007 news migrations and retained rows stay
-- untouched.
PRAGMA foreign_keys = ON;

ALTER TABLE jobs ADD COLUMN processing_policy_version TEXT NOT NULL DEFAULT 'v1';
ALTER TABLE jobs ADD COLUMN cache_valid INTEGER NOT NULL DEFAULT 1 CHECK (cache_valid IN (0, 1));

CREATE TABLE IF NOT EXISTS job_dispatch_intents (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('pending', 'leased', 'started', 'complete')),
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at TEXT NOT NULL,
  lease_expires_at TEXT,
  workflow_instance_id TEXT NOT NULL,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_dispatch_due
  ON job_dispatch_intents(state, available_at, lease_expires_at, updated_at);

CREATE TABLE IF NOT EXISTS job_deliveries (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('not_started', 'sending', 'confirmed', 'rejected', 'unknown')),
  method TEXT CHECK (method IS NULL OR method IN ('telegram', 'telegram_url', 'r2')),
  telegram_message_id TEXT,
  object_key TEXT,
  filename TEXT,
  mime_type TEXT,
  size_bytes INTEGER CHECK (size_bytes IS NULL OR (size_bytes >= 0 AND size_bytes <= 9007199254740991)),
  expires_at TEXT,
  unknown_reason TEXT,
  owner_generation INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_job_deliveries_state
  ON job_deliveries(state, updated_at, job_id);

-- Existing jobs get an explicit dispatch outcome. Terminal jobs are complete
-- for dispatch purposes, while active legacy rows are marked unknown below so
-- recovery cannot race a request that was already inside the old send path.
INSERT OR IGNORE INTO job_dispatch_intents (
  job_id, state, generation, attempts, available_at, lease_expires_at,
  workflow_instance_id, last_error_code, last_error_message, created_at, updated_at
)
SELECT id,
       -- Rows accepted before this migration may still be inside the old
       -- webhook's copy/send path. Do not auto-start a second Workflow while
       -- that request can still be alive; those rows are explicit operator
       -- cases below rather than age-released work.
       'complete',
       0,
       0,
       created_at,
       NULL,
       id,
       NULL,
       NULL,
       created_at,
       updated_at
FROM jobs;

-- Preserve legacy confirmed receipts as delivery history. Cache validity is a
-- separate flag so a stale Telegram pointer can be evicted without changing
-- successful-delivery statistics.
INSERT OR IGNORE INTO job_deliveries (
  job_id, state, method, telegram_message_id, object_key, filename, mime_type,
  size_bytes, expires_at, unknown_reason, owner_generation, created_at, updated_at
)
SELECT id,
       CASE
         WHEN status = 'completed'
              AND result_message_id GLOB '[1-9]*'
              AND result_message_id NOT GLOB '*[^0-9]*'
              AND length(result_message_id) <= 16
              AND (length(result_message_id) < 16 OR result_message_id <= '9007199254740991')
           THEN 'confirmed'
         WHEN status NOT IN ('completed', 'failed') THEN 'unknown'
         WHEN result_message_id IS NOT NULL THEN 'unknown'
         ELSE 'not_started'
       END,
       CASE WHEN r2_object_key IS NOT NULL THEN 'r2' ELSE 'telegram' END,
       CASE
         WHEN status = 'completed'
              AND result_message_id GLOB '[1-9]*'
              AND result_message_id NOT GLOB '*[^0-9]*'
              AND length(result_message_id) <= 16
              AND (length(result_message_id) < 16 OR result_message_id <= '9007199254740991')
           THEN result_message_id
         ELSE NULL
       END,
       r2_object_key,
       output_filename,
       output_mime_type,
       CASE
         WHEN typeof(output_size_bytes) = 'integer'
              AND output_size_bytes BETWEEN 0 AND 9007199254740991
           THEN output_size_bytes
         ELSE NULL
       END,
       expires_at,
       CASE
         WHEN status NOT IN ('completed', 'failed') THEN 'legacy_active_before_durable_dispatch'
         WHEN result_message_id IS NOT NULL THEN 'legacy_receipt_unvalidated'
         ELSE NULL
       END,
       NULL,
       created_at,
       updated_at
FROM jobs;
