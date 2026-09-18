-- Global and per-user admission semaphores. A row exists only while a job is
-- in an active state; the Worker reserves it in the same D1 batch that creates
-- the job. This makes MAX_ACTIVE_JOBS a transaction-level invariant rather
-- than a best-effort count followed by an insert.
CREATE TABLE IF NOT EXISTS active_job_admissions (
  job_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_active_job_admissions_created
  ON active_job_admissions (created_at);

-- These rows are transient assertions inside createJobWithUpdateReservation.
-- The Worker deletes them before the batch commits. Keeping the assertion in
-- SQL lets a zero-row conditional INSERT abort the whole transaction.
CREATE TABLE IF NOT EXISTS job_admission_guards (
  job_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('active', 'hourly')),
  PRIMARY KEY (job_id, kind)
);

CREATE TRIGGER IF NOT EXISTS reject_missing_active_admission
BEFORE INSERT ON job_admission_guards
WHEN NEW.kind = 'active' AND NEW.job_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'ACTIVE_JOB_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS reject_hourly_admission
BEFORE INSERT ON job_admission_guards
WHEN NEW.kind = 'hourly' AND NEW.job_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'HOURLY_JOB_LIMIT');
END;

CREATE TRIGGER IF NOT EXISTS release_active_job_admission
AFTER UPDATE OF status ON jobs
WHEN NEW.status IN ('completed', 'failed')
BEGIN
  DELETE FROM active_job_admissions WHERE job_id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS release_deleted_job_admission
AFTER DELETE ON jobs
BEGIN
  DELETE FROM active_job_admissions WHERE job_id = OLD.id;
END;

-- Preserve the admission count for active jobs that predate this migration.
INSERT OR IGNORE INTO active_job_admissions (job_id, created_at)
SELECT id, created_at
FROM jobs
WHERE status IN ('received', 'queued', 'probing', 'downloading', 'processing', 'uploading');
