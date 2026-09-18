import {
  miniAppInitDataFromRequest,
  validateTelegramMiniAppInitDataIdentity,
} from "./mini-app-auth";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  constantTimeEqualString,
} from "./security";
import { parseAllowedTelegramUserIds } from "./telegram-user-ids";
import type { D1BatchDatabaseLike } from "./types";

const encoder = new TextEncoder();
const PAIRING_TTL_SECONDS = 5 * 60;
const ACCESS_TTL_SECONDS = 15 * 60;
const REFRESH_TTL_SECONDS = 7 * 24 * 60 * 60;
const SESSION_ABSOLUTE_TTL_SECONDS = 30 * 24 * 60 * 60;
const INVITATION_DEFAULT_TTL_SECONDS = 24 * 60 * 60;
const INVITATION_MAX_TTL_SECONDS = 7 * 24 * 60 * 60;
const PUBLIC_WINDOW_SECONDS = 10 * 60;
const ACCOUNT_WINDOW_SECONDS = 60;
const MAX_JSON_BYTES = 4 * 1024;
const OPAQUE_TOKEN = /^[A-Za-z0-9_-]{43}$/u;
const INVITATION_TOKEN = /^inv_[A-Za-z0-9_-]{43}$/u;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const INTEGRATION_AUTH_POLICY = Object.freeze({
  pairingTtlSeconds: PAIRING_TTL_SECONDS,
  accessTtlSeconds: ACCESS_TTL_SECONDS,
  refreshTtlSeconds: REFRESH_TTL_SECONDS,
  sessionAbsoluteTtlSeconds: SESSION_ABSOLUTE_TTL_SECONDS,
  publicRequestsPerWindow: 20,
  pairingCreatesPerWindow: 10,
  authenticatedRequestsPerMinute: 120,
});

export interface IntegrationAuthEnv {
  DB: D1BatchDatabaseLike;
  TELEGRAM_BOT_TOKEN: string;
  ALLOWED_TELEGRAM_USER_IDS: string;
}

export interface IntegrationTelegramIdentity {
  telegramUserId: string;
  privateChatId: string;
}

export interface IntegrationTelegramAccount {
  accountId: string;
  telegramUserId: string;
  chatId: string;
  admissionSource: "legacy_allowlist" | "invitation";
}

export interface IntegrationPrincipal extends IntegrationTelegramAccount {
  sessionId: string | null;
  authMethod: "device_session" | "telegram_init_data";
}

export type IntegrationAuthentication =
  | Readonly<{ ok: true; principal: IntegrationPrincipal }>
  | Readonly<{ ok: false; status: 401 | 429; code: "UNAUTHORIZED" | "RATE_LIMITED" }>;

export interface IntegrationSessionCredentials {
  tokenType: "Bearer";
  accountId: string;
  sessionId: string;
  accessToken: string;
  accessExpiresAt: string;
  refreshToken: string;
  refreshExpiresAt: string;
  absoluteExpiresAt: string;
}

interface AccountRow {
  id: string;
  telegram_user_id: string;
  telegram_chat_id: string;
  admission_source: "legacy_allowlist" | "invitation";
}

interface PairingRow {
  id: string;
  confirmation_code: string;
  device_name: string;
  expires_at: number;
  approved_account_id: string | null;
}

interface SessionRow extends AccountRow {
  session_id: string;
  access_expires_at: number;
  refresh_expires_at: number;
  absolute_expires_at: number;
}

function unixNow(): number {
  return Math.floor(Date.now() / 1000);
}

function isoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function randomToken(): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function keyedRateIdentity(secret: string, value: string): Promise<string> {
  if (!secret) throw new Error("Missing Telegram bot token for integration rate limiting");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
  return bytesToBase64Url(digest);
}

function validOpaqueToken(value: unknown): value is string {
  if (typeof value !== "string" || !OPAQUE_TOKEN.test(value)) return false;
  return base64UrlToBytes(value)?.byteLength === 32;
}

function validPrivateIdentity(identity: IntegrationTelegramIdentity): boolean {
  if (identity.telegramUserId !== identity.privateChatId) return false;
  if (!/^[1-9]\d{0,19}$/u.test(identity.telegramUserId)) return false;
  const numeric = Number(identity.telegramUserId);
  return Number.isSafeInteger(numeric) && numeric > 0 && String(numeric) === identity.telegramUserId;
}

function accountFromRow(row: AccountRow): IntegrationTelegramAccount {
  return {
    accountId: row.id,
    telegramUserId: row.telegram_user_id,
    chatId: row.telegram_chat_id,
    admissionSource: row.admission_source,
  };
}

async function accountByTelegramUser(
  env: IntegrationAuthEnv,
  telegramUserId: string,
): Promise<IntegrationTelegramAccount | null> {
  const row = await env.DB.prepare(
    `SELECT id, telegram_user_id, telegram_chat_id, admission_source
       FROM integration_accounts
      WHERE telegram_user_id = ?1 AND status = 'active'`,
  ).bind(telegramUserId).first<AccountRow>();
  return row ? accountFromRow(row) : null;
}

export async function integrationAccountForTelegram(
  env: IntegrationAuthEnv,
  identity: IntegrationTelegramIdentity,
  nowSeconds = unixNow(),
): Promise<IntegrationTelegramAccount | null> {
  if (!validPrivateIdentity(identity)) return null;
  const existing = await accountByTelegramUser(env, identity.telegramUserId);
  if (existing) return existing;

  const legacyUsers = parseAllowedTelegramUserIds(env.ALLOWED_TELEGRAM_USER_IDS);
  if (!legacyUsers?.has(identity.telegramUserId)) return null;
  const accountId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT OR IGNORE INTO integration_accounts
       (id, telegram_user_id, telegram_chat_id, status, admission_source, invitation_id, created_at, revoked_at)
     VALUES (?1, ?2, ?3, 'active', 'legacy_allowlist', NULL, ?4, NULL)`,
  ).bind(accountId, identity.telegramUserId, identity.privateChatId, nowSeconds).run();
  return accountByTelegramUser(env, identity.telegramUserId);
}

function isConstraintFailure(error: unknown): boolean {
  return error instanceof Error
    && /(?:constraint|unique|INTEGRATION_(?:INVITATION_NOT_ADMISSIBLE|PAIRING_NOT_EXCHANGEABLE))/iu.test(error.message);
}

export async function createIntegrationInvitation(
  env: IntegrationAuthEnv,
  input: Readonly<{ issuerTelegramUserId: string; ttlSeconds?: number }>,
  nowSeconds = unixNow(),
): Promise<Readonly<{ invitationId: string; inviteToken: string; expiresAt: string }> | null> {
  const legacyUsers = parseAllowedTelegramUserIds(env.ALLOWED_TELEGRAM_USER_IDS);
  if (!legacyUsers?.has(input.issuerTelegramUserId)) return null;
  const ttlSeconds = input.ttlSeconds ?? INVITATION_DEFAULT_TTL_SECONDS;
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < PAIRING_TTL_SECONDS || ttlSeconds > INVITATION_MAX_TTL_SECONDS) return null;

  const invitationId = crypto.randomUUID();
  const inviteToken = `inv_${randomToken()}`;
  const expiresAt = nowSeconds + ttlSeconds;
  await env.DB.prepare(
    `INSERT INTO integration_invitations
       (id, token_hash, issued_by_telegram_user_id, created_at, expires_at, revoked_at, consumed_at, consumed_by_account_id)
     VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL)`,
  ).bind(invitationId, await sha256(inviteToken), input.issuerTelegramUserId, nowSeconds, expiresAt).run();
  return { invitationId, inviteToken, expiresAt: isoTime(expiresAt) };
}

export async function revokeIntegrationInvitation(
  env: IntegrationAuthEnv,
  input: Readonly<{ issuerTelegramUserId: string; invitationId: string }>,
  nowSeconds = unixNow(),
): Promise<boolean> {
  const legacyUsers = parseAllowedTelegramUserIds(env.ALLOWED_TELEGRAM_USER_IDS);
  if (!legacyUsers?.has(input.issuerTelegramUserId) || !UUID_V4.test(input.invitationId)) return false;
  const result = await env.DB.prepare(
    `UPDATE integration_invitations
        SET revoked_at = ?1
      WHERE id = ?2 AND revoked_at IS NULL AND consumed_at IS NULL`,
  ).bind(nowSeconds, input.invitationId).run();
  return (result.meta?.changes ?? 0) === 1;
}

export async function admitIntegrationInvite(
  env: IntegrationAuthEnv,
  input: IntegrationTelegramIdentity & Readonly<{ inviteToken: string }>,
  nowSeconds = unixNow(),
): Promise<IntegrationTelegramAccount | null> {
  if (!validPrivateIdentity(input) || !INVITATION_TOKEN.test(input.inviteToken)) return null;
  const existing = await accountByTelegramUser(env, input.telegramUserId);
  if (existing) return existing;

  const tokenHash = await sha256(input.inviteToken);
  const invitation = await env.DB.prepare(
    "SELECT id FROM integration_invitations WHERE token_hash = ?1",
  ).bind(tokenHash).first<{ id: string }>();
  if (!invitation) return null;

  const accountId = crypto.randomUUID();
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO integration_invitation_claims
           (invitation_id, token_hash, account_id, telegram_user_id, telegram_chat_id, claimed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
      ).bind(invitation.id, tokenHash, accountId, input.telegramUserId, input.privateChatId, nowSeconds),
      env.DB.prepare(
        `INSERT INTO integration_accounts
           (id, telegram_user_id, telegram_chat_id, status, admission_source, invitation_id, created_at, revoked_at)
         VALUES (?1, ?2, ?3, 'active', 'invitation', ?4, ?5, NULL)`,
      ).bind(accountId, input.telegramUserId, input.privateChatId, invitation.id, nowSeconds),
    ]);
  } catch (error) {
    if (!isConstraintFailure(error)) throw error;
    return accountByTelegramUser(env, input.telegramUserId);
  }
  return accountByTelegramUser(env, input.telegramUserId);
}

export async function createIntegrationPairing(
  env: IntegrationAuthEnv,
  input: Readonly<{ verifier: string; deviceName: string }>,
  nowSeconds = unixNow(),
): Promise<Readonly<{
  pairId: string;
  confirmationCode: string;
  deviceName: string;
  expiresAt: string;
  telegramStartParameter: string;
}>> {
  if (!validOpaqueToken(input.verifier)) throw new TypeError("Invalid pairing verifier");
  const deviceName = input.deviceName.normalize("NFKC").trim();
  const hasControlCharacter = [...deviceName].some((character) => {
    const code = character.charCodeAt(0);
    return code < 0x20 || code === 0x7f;
  });
  if (!deviceName || deviceName.length > 64 || hasControlCharacter) {
    throw new TypeError("Invalid device name");
  }

  const pairId = crypto.randomUUID();
  const randomCode = crypto.getRandomValues(new Uint32Array(1))[0] ?? 0;
  const confirmationCode = String(randomCode % 1_000_000).padStart(6, "0");
  const expiresAt = nowSeconds + PAIRING_TTL_SECONDS;
  await env.DB.prepare(
    `INSERT INTO integration_pairings
       (id, verifier_hash, confirmation_code, device_name, created_at, expires_at,
        approved_account_id, approved_chat_id, approved_at, consumed_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, NULL)`,
  ).bind(pairId, await sha256(input.verifier), confirmationCode, deviceName, nowSeconds, expiresAt).run();
  return {
    pairId,
    confirmationCode,
    deviceName,
    expiresAt: isoTime(expiresAt),
    telegramStartParameter: `pair_${pairId}`,
  };
}

export async function getIntegrationPairingSummary(
  env: IntegrationAuthEnv,
  input: IntegrationTelegramIdentity & Readonly<{ pairId: string }>,
  nowSeconds = unixNow(),
): Promise<Readonly<{ pairId: string; deviceName: string; confirmationCode: string; expiresAt: string }> | null> {
  if (!UUID_V4.test(input.pairId)) return null;
  const account = await integrationAccountForTelegram(env, input, nowSeconds);
  if (!account) return null;
  const row = await env.DB.prepare(
    `SELECT id, confirmation_code, device_name, expires_at, approved_account_id
       FROM integration_pairings
      WHERE id = ?1 AND expires_at > ?2 AND consumed_at IS NULL AND approved_account_id IS NULL`,
  ).bind(input.pairId, nowSeconds).first<PairingRow>();
  return row ? {
    pairId: row.id,
    deviceName: row.device_name,
    confirmationCode: row.confirmation_code,
    expiresAt: isoTime(row.expires_at),
  } : null;
}

export async function approveIntegrationPairing(
  env: IntegrationAuthEnv,
  input: IntegrationTelegramIdentity & Readonly<{ pairId: string; confirmationCode: string }>,
  nowSeconds = unixNow(),
): Promise<IntegrationTelegramAccount | null> {
  if (!UUID_V4.test(input.pairId) || !/^\d{6}$/u.test(input.confirmationCode)) return null;
  const account = await integrationAccountForTelegram(env, input, nowSeconds);
  if (!account) return null;
  const pairing = await env.DB.prepare(
    `SELECT id, confirmation_code, device_name, expires_at, approved_account_id
       FROM integration_pairings
      WHERE id = ?1 AND expires_at > ?2 AND consumed_at IS NULL`,
  ).bind(input.pairId, nowSeconds).first<PairingRow>();
  if (!pairing || !constantTimeEqualString(pairing.confirmation_code, input.confirmationCode)) return null;
  if (pairing.approved_account_id !== null) {
    return pairing.approved_account_id === account.accountId ? account : null;
  }
  await env.DB.prepare(
    `UPDATE integration_pairings
        SET approved_account_id = ?1, approved_chat_id = ?2, approved_at = ?3
      WHERE id = ?4 AND approved_account_id IS NULL AND consumed_at IS NULL AND expires_at > ?3`,
  ).bind(account.accountId, account.chatId, nowSeconds, input.pairId).run();
  const approved = await env.DB.prepare(
    "SELECT approved_account_id FROM integration_pairings WHERE id = ?1",
  ).bind(input.pairId).first<{ approved_account_id: string | null }>();
  return approved?.approved_account_id === account.accountId ? account : null;
}

function sessionCredentials(row: SessionRow, accessToken: string, refreshToken: string): IntegrationSessionCredentials {
  return {
    tokenType: "Bearer",
    accountId: row.id,
    sessionId: row.session_id,
    accessToken,
    accessExpiresAt: isoTime(row.access_expires_at),
    refreshToken,
    refreshExpiresAt: isoTime(row.refresh_expires_at),
    absoluteExpiresAt: isoTime(row.absolute_expires_at),
  };
}

export async function exchangeIntegrationPairing(
  env: IntegrationAuthEnv,
  input: Readonly<{ pairId: string; verifier: string }>,
  nowSeconds = unixNow(),
): Promise<IntegrationSessionCredentials | null> {
  if (!UUID_V4.test(input.pairId) || !validOpaqueToken(input.verifier)) return null;
  const sessionId = crypto.randomUUID();
  const accessToken = randomToken();
  const refreshToken = randomToken();
  const absoluteExpiresAt = nowSeconds + SESSION_ABSOLUTE_TTL_SECONDS;
  const accessExpiresAt = nowSeconds + ACCESS_TTL_SECONDS;
  const refreshExpiresAt = nowSeconds + REFRESH_TTL_SECONDS;
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO integration_pairing_claims (pairing_id, verifier_hash, session_id, claimed_at)
         VALUES (?1, ?2, ?3, ?4)`,
      ).bind(input.pairId, await sha256(input.verifier), sessionId, nowSeconds),
      env.DB.prepare(
        `INSERT INTO integration_sessions
           (id, account_id, pairing_id, device_name, access_token_hash, refresh_token_hash,
            access_expires_at, refresh_expires_at, absolute_expires_at, created_at, rotated_at, revoked_at)
         SELECT ?1, pairing.approved_account_id, pairing.id, pairing.device_name,
                ?2, ?3, ?4, ?5, ?6, ?7, ?7, NULL
           FROM integration_pairings pairing
           JOIN integration_accounts account
             ON account.id = pairing.approved_account_id AND account.status = 'active'
          WHERE pairing.id = ?8`,
      ).bind(
        sessionId,
        await sha256(accessToken),
        await sha256(refreshToken),
        accessExpiresAt,
        refreshExpiresAt,
        absoluteExpiresAt,
        nowSeconds,
        input.pairId,
      ),
    ]);
  } catch (error) {
    if (isConstraintFailure(error)) return null;
    throw error;
  }
  const row = await env.DB.prepare(
    `SELECT a.id, a.telegram_user_id, a.telegram_chat_id, a.admission_source,
            s.id AS session_id, s.access_expires_at, s.refresh_expires_at, s.absolute_expires_at
       FROM integration_sessions s
       JOIN integration_accounts a ON a.id = s.account_id
      WHERE s.id = ?1 AND a.status = 'active'`,
  ).bind(sessionId).first<SessionRow>();
  if (!row) throw new Error("Integration session transaction did not persist a session");
  return sessionCredentials(row, accessToken, refreshToken);
}

export async function refreshIntegrationSession(
  env: IntegrationAuthEnv,
  refreshToken: string,
  nowSeconds = unixNow(),
): Promise<IntegrationSessionCredentials | null> {
  if (!validOpaqueToken(refreshToken)) return null;
  const accessToken = randomToken();
  const nextRefreshToken = randomToken();
  const row = await env.DB.prepare(
    `UPDATE integration_sessions
        SET access_token_hash = ?1,
            refresh_token_hash = ?2,
            access_expires_at = MIN(?3, absolute_expires_at),
            refresh_expires_at = MIN(?4, absolute_expires_at),
            rotated_at = ?5
      WHERE refresh_token_hash = ?6
        AND revoked_at IS NULL
        AND refresh_expires_at > ?5
        AND absolute_expires_at > ?5
      RETURNING id AS session_id, account_id, access_expires_at, refresh_expires_at, absolute_expires_at`,
  ).bind(
    await sha256(accessToken),
    await sha256(nextRefreshToken),
    nowSeconds + ACCESS_TTL_SECONDS,
    nowSeconds + REFRESH_TTL_SECONDS,
    nowSeconds,
    await sha256(refreshToken),
  ).first<{
    session_id: string;
    account_id: string;
    access_expires_at: number;
    refresh_expires_at: number;
    absolute_expires_at: number;
  }>();
  if (!row) return null;
  const account = await env.DB.prepare(
    `SELECT id, telegram_user_id, telegram_chat_id, admission_source
       FROM integration_accounts WHERE id = ?1 AND status = 'active'`,
  ).bind(row.account_id).first<AccountRow>();
  if (!account) return null;
  return sessionCredentials({ ...account, ...row }, accessToken, nextRefreshToken);
}

async function takeRateLimit(
  env: IntegrationAuthEnv,
  bucketKey: string,
  limit: number,
  windowSeconds: number,
  nowSeconds: number,
): Promise<boolean> {
  const windowStartedAt = Math.floor(nowSeconds / windowSeconds) * windowSeconds;
  const row = await env.DB.prepare(
    `INSERT INTO integration_rate_limits (bucket_key, window_started_at, request_count, expires_at)
     VALUES (?1, ?2, 1, ?3)
     ON CONFLICT(bucket_key) DO UPDATE SET
       window_started_at = excluded.window_started_at,
       request_count = CASE
         WHEN integration_rate_limits.window_started_at = excluded.window_started_at
         THEN integration_rate_limits.request_count + 1 ELSE 1 END,
       expires_at = excluded.expires_at
     WHERE integration_rate_limits.window_started_at <> excluded.window_started_at
        OR integration_rate_limits.request_count < ?4
     RETURNING request_count`,
  ).bind(bucketKey, windowStartedAt, windowStartedAt + windowSeconds, limit).first<{ request_count: number }>();
  return row !== null;
}

async function takePublicRateLimit(
  request: Request,
  env: IntegrationAuthEnv,
  scope: string,
  limit: number,
  nowSeconds: number,
): Promise<boolean> {
  const client = request.headers.get("cf-connecting-ip") ?? "missing";
  const identity = await keyedRateIdentity(env.TELEGRAM_BOT_TOKEN, client);
  return takeRateLimit(env, `public:${scope}:${identity}`, limit, PUBLIC_WINDOW_SECONDS, nowSeconds);
}

async function takeAccountRateLimit(
  env: IntegrationAuthEnv,
  accountId: string,
  nowSeconds: number,
): Promise<boolean> {
  return takeRateLimit(
    env,
    `account:${accountId}`,
    INTEGRATION_AUTH_POLICY.authenticatedRequestsPerMinute,
    ACCOUNT_WINDOW_SECONDS,
    nowSeconds,
  );
}

export async function authenticateIntegrationRequest(
  request: Request,
  env: IntegrationAuthEnv,
  nowSeconds = unixNow(),
): Promise<IntegrationAuthentication> {
  const authorization = request.headers.get("authorization") ?? "";
  let principal: IntegrationPrincipal | null = null;

  const bearer = authorization.match(/^Bearer ([A-Za-z0-9_-]{43})$/u)?.[1];
  if (bearer && validOpaqueToken(bearer)) {
    const row = await env.DB.prepare(
      `SELECT a.id, a.telegram_user_id, a.telegram_chat_id, a.admission_source,
              s.id AS session_id, s.access_expires_at, s.refresh_expires_at, s.absolute_expires_at
         FROM integration_sessions s
         JOIN integration_accounts a ON a.id = s.account_id
        WHERE s.access_token_hash = ?1
          AND s.revoked_at IS NULL
          AND s.access_expires_at > ?2
          AND s.absolute_expires_at > ?2
          AND a.status = 'active'`,
    ).bind(await sha256(bearer), nowSeconds).first<SessionRow>();
    if (row) {
      principal = {
        ...accountFromRow(row),
        sessionId: row.session_id,
        authMethod: "device_session",
      };
    }
  } else {
    const initData = miniAppInitDataFromRequest(request);
    const signedUser = initData
      ? await validateTelegramMiniAppInitDataIdentity(initData, env.TELEGRAM_BOT_TOKEN, nowSeconds)
      : null;
    const account = signedUser
      ? await integrationAccountForTelegram(env, {
          telegramUserId: signedUser.userId,
          privateChatId: signedUser.userId,
        }, nowSeconds)
      : null;
    if (account) principal = { ...account, sessionId: null, authMethod: "telegram_init_data" };
  }

  if (!principal) return { ok: false, status: 401, code: "UNAUTHORIZED" };
  if (!await takeAccountRateLimit(env, principal.accountId, nowSeconds)) {
    return { ok: false, status: 429, code: "RATE_LIMITED" };
  }
  return { ok: true, principal };
}

async function readBoundedJson(request: Request): Promise<Record<string, unknown> | null> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return null;
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_JSON_BYTES) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_JSON_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key)) && keys.every((key) => key in value);
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable = false,
  headers: Record<string, string> = {},
): Response {
  return jsonResponse(status, { error: { code, message, retryable } }, headers);
}

function rateLimitedResponse(): Response {
  return errorResponse(
    429,
    "rate_limited",
    "Too many integration requests. Try again shortly.",
    true,
    { "retry-after": String(PUBLIC_WINDOW_SECONDS) },
  );
}

function methodNotAllowed(): Response {
  return errorResponse(405, "method_not_allowed", "Method not allowed.");
}

export async function handleIntegrationAuth(
  request: Request,
  env: IntegrationAuthEnv,
  nowSeconds = unixNow(),
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path === "/api/integration/pairings") {
    if (request.method !== "POST") return methodNotAllowed();
    if (!await takePublicRateLimit(request, env, "pair-create", INTEGRATION_AUTH_POLICY.pairingCreatesPerWindow, nowSeconds)) {
      return rateLimitedResponse();
    }
    const body = await readBoundedJson(request);
    if (!body || !hasOnlyKeys(body, ["verifier", "deviceName"])) {
      return errorResponse(400, "invalid_request", "Choose a valid verifier and device name.");
    }
    try {
      const pairing = await createIntegrationPairing(env, {
        verifier: body.verifier as string,
        deviceName: body.deviceName as string,
      }, nowSeconds);
      return jsonResponse(201, {
        pairId: pairing.pairId,
        confirmationCode: pairing.confirmationCode,
        expiresAt: pairing.expiresAt,
      });
    } catch (error) {
      if (error instanceof TypeError) {
        return errorResponse(400, "invalid_request", "Choose a valid verifier and device name.");
      }
      throw error;
    }
  }

  const pairingExchange = path.match(/^\/api\/integration\/pairings\/([0-9a-f-]+)\/exchange$/iu);
  if (pairingExchange) {
    if (request.method !== "POST") return methodNotAllowed();
    if (!await takePublicRateLimit(request, env, "pair-exchange", INTEGRATION_AUTH_POLICY.publicRequestsPerWindow, nowSeconds)) {
      return rateLimitedResponse();
    }
    const body = await readBoundedJson(request);
    if (!body || !hasOnlyKeys(body, ["verifier"])) {
      return errorResponse(400, "invalid_request", "Provide the verifier created by this device.");
    }
    const credentials = await exchangeIntegrationPairing(env, {
      pairId: pairingExchange[1] ?? "",
      verifier: body.verifier as string,
    }, nowSeconds);
    return credentials
      ? jsonResponse(200, credentials)
      : errorResponse(409, "pairing_not_ready", "Approve this pairing in DigiBot, then try again.", true);
  }

  if (path === "/api/integration/sessions/refresh") {
    if (request.method !== "POST") return methodNotAllowed();
    if (!await takePublicRateLimit(request, env, "session-refresh", INTEGRATION_AUTH_POLICY.publicRequestsPerWindow, nowSeconds)) {
      return rateLimitedResponse();
    }
    const body = await readBoundedJson(request);
    if (!body || !hasOnlyKeys(body, ["refreshToken"])) {
      return errorResponse(400, "invalid_request", "Provide a valid refresh token.");
    }
    const credentials = await refreshIntegrationSession(env, body.refreshToken as string, nowSeconds);
    return credentials
      ? jsonResponse(200, credentials)
      : errorResponse(401, "invalid_refresh_token", "This device session has expired. Pair it again.");
  }

  const sessionDelete = path.match(/^\/api\/integration\/sessions\/([0-9a-f-]+)$/iu);
  if (sessionDelete) {
    if (request.method !== "DELETE") return methodNotAllowed();
    const authentication = await authenticateIntegrationRequest(request, env, nowSeconds);
    if (!authentication.ok) {
      return authentication.status === 429
        ? rateLimitedResponse()
        : errorResponse(401, "unauthorized", "Link this device to DigiBot, or sign in again.");
    }
    const sessionId = sessionDelete[1] ?? "";
    if (!UUID_V4.test(sessionId)) return errorResponse(404, "not_found", "Device session not found.");
    await env.DB.prepare(
      `UPDATE integration_sessions SET revoked_at = ?1
        WHERE id = ?2 AND account_id = ?3 AND revoked_at IS NULL`,
    ).bind(nowSeconds, sessionId, authentication.principal.accountId).run();
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }

  return null;
}
