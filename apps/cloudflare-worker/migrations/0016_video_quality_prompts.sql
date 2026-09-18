-- Prompts contain encrypted sources only for their ten-minute lifetime.
ALTER TABLE telegram_notices ADD COLUMN reply_markup TEXT;
CREATE TABLE video_quality_prompts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE,
  chat_id TEXT NOT NULL,
  update_id TEXT NOT NULL UNIQUE REFERENCES processed_updates(telegram_update_id) ON DELETE CASCADE,
  request_message_id TEXT NOT NULL,
  maximum_height INTEGER NOT NULL CHECK(maximum_height IN (144, 240, 360, 480, 720, 1080)),
  source_host TEXT NOT NULL,
  source_url_hash TEXT NOT NULL,
  source_url_encrypted TEXT NOT NULL,
  trim_start_seconds INTEGER,
  trim_end_seconds INTEGER,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX video_quality_prompts_expiry ON video_quality_prompts(expires_at);
CREATE TABLE video_quality_choices (
  token TEXT PRIMARY KEY,
  prompt_id TEXT NOT NULL REFERENCES video_quality_prompts(id) ON DELETE CASCADE,
  choice TEXT NOT NULL CHECK(choice IN ('automatic', '720', '480', '360', 'cancel')),
  UNIQUE(prompt_id, choice)
);
-- A failed conditional claim must abort the entire admission transaction.
CREATE TABLE video_quality_claims (
  id TEXT PRIMARY KEY,
  valid INTEGER NOT NULL CONSTRAINT VIDEO_QUALITY_PROMPT_UNAVAILABLE CHECK(valid = 1)
);
