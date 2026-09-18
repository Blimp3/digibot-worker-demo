-- Additive integration records; legacy jobs and counters keep their meaning.
CREATE TABLE integration_media (
  account_id TEXT NOT NULL REFERENCES integration_accounts(id),
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length > 0),
  mime_type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (account_id, sha256)
);

CREATE TABLE integration_archives (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES integration_accounts(id),
  media_sha256 TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('automatic', 'download')),
  delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK (delivery_state IN ('pending', 'sending', 'confirmed', 'failed', 'unknown')),
  receipt_json TEXT,
  integrity_state TEXT NOT NULL DEFAULT 'not_checked' CHECK (integrity_state IN ('not_checked', 'verified', 'mismatch', 'failed')),
  round_trip_sha256 TEXT,
  error_json TEXT,
  attempt_started_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX integration_automatic_archive ON integration_archives(account_id, media_sha256) WHERE kind = 'automatic';

CREATE TABLE integration_operations (
  id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES integration_accounts(id),
  action TEXT NOT NULL CHECK (action IN ('check', 'download')),
  request_hash TEXT NOT NULL,
  input_json TEXT,
  segment_json TEXT,
  source_cipher TEXT,
  media_sha256 TEXT,
  archive_id TEXT REFERENCES integration_archives(id),
  status TEXT NOT NULL CHECK (status IN ('awaiting_upload', 'queued', 'processing', 'completed', 'failed')),
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  admitted_at TEXT,
  upload_token TEXT,
  upload_started_at TEXT,
  temp_key TEXT,
  result_json TEXT,
  error_json TEXT,
  provider_started_at TEXT,
  provider_attempts INTEGER NOT NULL DEFAULT 0,
  reserved_bytes INTEGER NOT NULL CHECK (reserved_bytes >= 0),
  run_generation INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX integration_account_history ON integration_operations(account_id, requested_at DESC, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX integration_pending_work ON integration_operations(status, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX integration_media_operations ON integration_operations(account_id, media_sha256);
