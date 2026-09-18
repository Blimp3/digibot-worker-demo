-- Linked-account admission and revocable device sessions. Legacy jobs remain
-- keyed by Telegram identity; later integration tables reference account IDs.
CREATE TABLE IF NOT EXISTS integration_accounts (
  id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  admission_source TEXT NOT NULL CHECK (admission_source IN ('legacy_allowlist', 'invitation')),
  invitation_id TEXT UNIQUE,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (telegram_user_id = telegram_chat_id),
  CHECK (
    (status = 'active' AND revoked_at IS NULL)
    OR (status = 'revoked' AND revoked_at IS NOT NULL)
  ),
  CHECK (
    (admission_source = 'legacy_allowlist' AND invitation_id IS NULL)
    OR (admission_source = 'invitation' AND invitation_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS integration_invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE CHECK (length(token_hash) = 64),
  issued_by_telegram_user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  consumed_at INTEGER,
  consumed_by_account_id TEXT,
  CHECK (expires_at > created_at),
  CHECK (
    (consumed_at IS NULL AND consumed_by_account_id IS NULL)
    OR (consumed_at IS NOT NULL AND consumed_by_account_id IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS integration_invitation_claims (
  invitation_id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL CHECK (length(token_hash) = 64),
  account_id TEXT NOT NULL UNIQUE,
  telegram_user_id TEXT NOT NULL UNIQUE,
  telegram_chat_id TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  CHECK (telegram_user_id = telegram_chat_id)
);

-- Keep trigger CASE expressions parenthesized for D1's migration splitter:
-- https://github.com/cloudflare/workers-sdk/issues/4727
CREATE TRIGGER IF NOT EXISTS validate_integration_invitation_claim
BEFORE INSERT ON integration_invitation_claims
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
      FROM integration_invitations
     WHERE id = NEW.invitation_id
       AND token_hash = NEW.token_hash
       AND revoked_at IS NULL
       AND consumed_at IS NULL
       AND expires_at > NEW.claimed_at
  ) THEN RAISE(ABORT, 'INTEGRATION_INVITATION_NOT_ADMISSIBLE') END);
END;

CREATE TRIGGER IF NOT EXISTS consume_integration_invitation
AFTER INSERT ON integration_invitation_claims
BEGIN
  UPDATE integration_invitations
     SET consumed_at = NEW.claimed_at,
         consumed_by_account_id = NEW.account_id
   WHERE id = NEW.invitation_id;
END;

CREATE TABLE IF NOT EXISTS integration_pairings (
  id TEXT PRIMARY KEY,
  verifier_hash TEXT NOT NULL UNIQUE CHECK (length(verifier_hash) = 64),
  confirmation_code TEXT NOT NULL CHECK (length(confirmation_code) = 6),
  device_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  approved_account_id TEXT,
  approved_chat_id TEXT,
  approved_at INTEGER,
  consumed_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (
    (approved_account_id IS NULL AND approved_chat_id IS NULL AND approved_at IS NULL)
    OR (approved_account_id IS NOT NULL AND approved_chat_id IS NOT NULL AND approved_at IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS integration_pairing_claims (
  pairing_id TEXT PRIMARY KEY,
  verifier_hash TEXT NOT NULL CHECK (length(verifier_hash) = 64),
  session_id TEXT NOT NULL UNIQUE,
  claimed_at INTEGER NOT NULL
);

CREATE TRIGGER IF NOT EXISTS validate_integration_pairing_claim
BEFORE INSERT ON integration_pairing_claims
BEGIN
  SELECT (CASE WHEN NOT EXISTS (
    SELECT 1
      FROM integration_pairings pairing
      JOIN integration_accounts account
        ON account.id = pairing.approved_account_id
       AND account.telegram_chat_id = pairing.approved_chat_id
       AND account.status = 'active'
     WHERE pairing.id = NEW.pairing_id
       AND pairing.verifier_hash = NEW.verifier_hash
       AND pairing.consumed_at IS NULL
       AND pairing.expires_at > NEW.claimed_at
  ) THEN RAISE(ABORT, 'INTEGRATION_PAIRING_NOT_EXCHANGEABLE') END);
END;

CREATE TRIGGER IF NOT EXISTS consume_integration_pairing
AFTER INSERT ON integration_pairing_claims
BEGIN
  UPDATE integration_pairings
     SET consumed_at = NEW.claimed_at
   WHERE id = NEW.pairing_id;
END;

CREATE TABLE IF NOT EXISTS integration_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  pairing_id TEXT NOT NULL UNIQUE,
  device_name TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE CHECK (length(access_token_hash) = 64),
  refresh_token_hash TEXT NOT NULL UNIQUE CHECK (length(refresh_token_hash) = 64),
  access_expires_at INTEGER NOT NULL,
  refresh_expires_at INTEGER NOT NULL,
  absolute_expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  rotated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (access_expires_at <= absolute_expires_at),
  CHECK (refresh_expires_at <= absolute_expires_at)
);

CREATE INDEX IF NOT EXISTS idx_integration_sessions_account
  ON integration_sessions (account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integration_rate_limits (
  bucket_key TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  request_count INTEGER NOT NULL CHECK (request_count > 0),
  expires_at INTEGER NOT NULL
);
