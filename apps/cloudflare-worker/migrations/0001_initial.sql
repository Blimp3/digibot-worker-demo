-- Telegram update IDs are kept separately so /start, /help and /status are
-- deduplicated too. Source URLs are encrypted at rest and are cleared after a
-- job reaches a terminal state.
CREATE TABLE IF NOT EXISTS processed_updates (
  telegram_update_id TEXT PRIMARY KEY,
  job_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  telegram_update_id TEXT UNIQUE NOT NULL,
  telegram_user_id TEXT NOT NULL,
  telegram_chat_id TEXT NOT NULL,
  request_message_id TEXT,
  waiting_message_id TEXT,
  result_message_id TEXT,
  source_host TEXT NOT NULL,
  source_url_hash TEXT NOT NULL,
  source_url_encrypted TEXT,
  requested_mode TEXT NOT NULL CHECK (requested_mode IN ('video', 'audio')),
  requested_quality TEXT,
  status TEXT NOT NULL CHECK (status IN ('received', 'queued', 'probing', 'downloading', 'processing', 'uploading', 'completed', 'failed')),
  progress INTEGER,
  output_filename TEXT,
  output_mime_type TEXT,
  output_size_bytes INTEGER,
  output_duration_seconds REAL,
  r2_object_key TEXT,
  error_code TEXT,
  safe_error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  expires_at TEXT,
  FOREIGN KEY (telegram_update_id) REFERENCES processed_updates (telegram_update_id)
);

CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs (telegram_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs (status, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_source_hash ON jobs (source_url_hash);
CREATE INDEX IF NOT EXISTS idx_jobs_telegram_update_id ON jobs (telegram_update_id);
CREATE INDEX IF NOT EXISTS idx_processed_updates_created ON processed_updates (created_at);
