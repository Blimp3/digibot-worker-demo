-- Queue accepted work without consuming a lane slot until promotion. The
-- limit is deliberately independent from the hourly request limit so a user
-- can hold only a small bounded amount of unfinished work.
CREATE TRIGGER IF NOT EXISTS reject_user_unfinished_job_limit
BEFORE INSERT ON jobs
WHEN (
  SELECT COUNT(*)
  FROM jobs
  WHERE telegram_user_id = NEW.telegram_user_id
    AND status NOT IN ('completed', 'failed')
) >= 5
 AND NEW.status NOT IN ('completed', 'failed')
BEGIN
  SELECT RAISE(ABORT, 'OUTSTANDING_JOB_LIMIT');
END;

CREATE INDEX IF NOT EXISTS idx_jobs_unfinished_user
  ON jobs (telegram_user_id, created_at, id)
  WHERE status NOT IN ('completed', 'failed');

-- A legacy Worker may still try to lease an intent directly. Requiring the
-- matching active admission at this boundary prevents it from bypassing the
-- new transactional promotion gate. Promotion inserts the admission first;
-- terminal transitions may release it before a late create acknowledgement,
-- so the started transition remains intentionally unrestricted.
CREATE TRIGGER IF NOT EXISTS reject_dispatch_lease_without_admission
BEFORE UPDATE OF state ON job_dispatch_intents
WHEN NEW.state = 'leased'
  AND NOT EXISTS (
    SELECT 1 FROM active_job_admissions
    WHERE job_id = NEW.job_id
  )
BEGIN
  SELECT RAISE(ABORT, 'DISPATCH_ADMISSION_REQUIRED');
END;
