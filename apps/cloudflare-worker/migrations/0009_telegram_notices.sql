-- Safe command/rejection text only; never store the original update or URL.
CREATE TABLE telegram_notices (
  update_id TEXT PRIMARY KEY REFERENCES processed_updates(telegram_update_id) ON DELETE CASCADE,
  chat_id TEXT NOT NULL,
  text TEXT NOT NULL CHECK (length(text) BETWEEN 1 AND 4096),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sending', 'sent', 'rejected', 'unknown')),
  generation INTEGER NOT NULL DEFAULT 0,
  last_attempt_at_seconds INTEGER NOT NULL DEFAULT 0,
  retry_after_seconds INTEGER NOT NULL DEFAULT 0 CHECK (retry_after_seconds >= 0),
  message_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
