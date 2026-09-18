-- Preserve a provider-supplied Telegram 429 delay on a proven rejection.
-- This is operator-visible metadata only; the Worker never auto-resends a
-- final delivery after the non-idempotent call has returned.
ALTER TABLE job_deliveries ADD COLUMN retry_after_seconds INTEGER
  CHECK (retry_after_seconds IS NULL OR (retry_after_seconds > 0 AND retry_after_seconds <= 9007199254740991));
