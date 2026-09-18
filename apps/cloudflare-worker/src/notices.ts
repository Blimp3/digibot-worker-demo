import { expireVideoQualityPrompts } from "./db";
import { getWorkerConfig } from "./config";
import { logStructured } from "./logging";
import { TelegramApiError, TelegramClient } from "./telegram";
import type { D1BatchDatabaseLike, Env, TelegramInlineKeyboardButton } from "./types";

interface Notice {
  update_id: string;
  chat_id: string;
  text: string;
  generation: number;
  created_at: string;
  reply_markup: string | null;
}

export interface WaitingNoticeResult {
  state: "pending" | "sending" | "sent" | "rejected" | "unknown";
  messageId: string | null;
  retryAfterSeconds: number;
}

/** The job's existing dispatch intent makes this notice recoverable too. */
export async function ensureWaitingNotice(env: Env, updateId: string, chatId: string, text: string): Promise<WaitingNoticeResult> {
  const now = new Date().toISOString();
  await env.DB.prepare(`INSERT OR IGNORE INTO telegram_notices (update_id, chat_id, text, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, ?4)`).bind(updateId, chatId, text, now).run();
  await dispatchNotices(env, updateId);
  const notice = await env.DB.prepare(`SELECT state, message_id, retry_after_seconds,
    last_attempt_at_seconds FROM telegram_notices WHERE update_id = ?1`).bind(updateId).first<{
      state: WaitingNoticeResult["state"]; message_id: string | null; retry_after_seconds: number; last_attempt_at_seconds: number;
    }>();
  if (!notice) throw new Error("Waiting notice missing");
  return {
    state: notice.state,
    messageId: notice.message_id,
    retryAfterSeconds: Math.max(1, notice.retry_after_seconds - (Math.floor(Date.now() / 1000) - notice.last_attempt_at_seconds)),
  };
}

/** A failed batch must not acknowledge an update whose reply was not saved. */
export async function enqueueNotice(db: D1BatchDatabaseLike, updateId: string, chatId: string, text: string, now = new Date()): Promise<boolean> {
  try {
    await db.batch([
      db.prepare("INSERT INTO processed_updates (telegram_update_id, job_id, created_at) VALUES (?1, NULL, ?2)").bind(updateId, now.toISOString()),
      db.prepare("INSERT INTO telegram_notices (update_id, chat_id, text, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?4)").bind(updateId, chatId, text, now.toISOString()),
    ]);
    return true;
  } catch (error) {
    // Only a proven duplicate can be acknowledged after an unsuccessful batch.
    if (await db.prepare("SELECT 1 AS present FROM processed_updates WHERE telegram_update_id = ?1").bind(updateId).first()) return false;
    throw error;
  }
}

export async function dispatchNotices(env: Env, updateId?: string, now = new Date()): Promise<void> {
  const db = env.DB;
  await expireVideoQualityPrompts(db, now.toISOString());
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const due = await db.prepare(`SELECT update_id, chat_id, text, generation, created_at, reply_markup FROM telegram_notices
    WHERE state = 'pending' AND ?1 - last_attempt_at_seconds >= retry_after_seconds
    AND (?2 IS NULL OR update_id = ?2) ORDER BY created_at LIMIT 10`).bind(nowSeconds, updateId ?? null).all<Notice>();
  const client = new TelegramClient({ token: env.TELEGRAM_BOT_TOKEN, apiBase: getWorkerConfig(env).telegramApiBase });
  for (const notice of due.results) {
    let replyMarkup: { inline_keyboard: TelegramInlineKeyboardButton[][] } | undefined;
    try { replyMarkup = parseQualityKeyboard(notice.reply_markup); }
    catch {
      await db.prepare("UPDATE telegram_notices SET state = 'rejected', reply_markup = NULL WHERE update_id = ?1 AND state = 'pending'").bind(notice.update_id).run();
      continue;
    }
    const generation = notice.generation + 1;
    const claim = await db.prepare(`UPDATE telegram_notices SET state = 'sending', generation = ?2,
      last_attempt_at_seconds = ?3, updated_at = ?4
      WHERE update_id = ?1 AND state = 'pending' AND generation = ?5
      AND ?3 - last_attempt_at_seconds >= retry_after_seconds
      AND (reply_markup IS NULL OR EXISTS (SELECT 1 FROM video_quality_prompts p
        WHERE p.update_id = telegram_notices.update_id AND p.expires_at > ?4))`).bind(notice.update_id, generation, nowSeconds, now.toISOString(), notice.generation).run();
    if (!claim.meta.changes) continue;
    let messageId: number;
    try {
      messageId = (await client.sendMessage(notice.chat_id, notice.text, replyMarkup)).message_id;
    } catch (error) {
      const retryAfter = error instanceof TelegramApiError ? error.durableRetry?.retryAfterSeconds : undefined;
      const state = retryAfter !== undefined ? "pending" : error instanceof TelegramApiError && error.outcome === "rejected" ? "rejected" : "unknown";
      const rejectedAt = new Date();
      await db.prepare(`UPDATE telegram_notices SET state = ?3, retry_after_seconds = ?4, updated_at = ?5,
        last_attempt_at_seconds = ?6
        WHERE update_id = ?1 AND generation = ?2 AND state = 'sending'`).bind(notice.update_id, generation, state, retryAfter ?? 0, rejectedAt.toISOString(), Math.ceil(rejectedAt.getTime() / 1000)).run();
      logStructured("telegram_notice_outcome", { state });
      continue;
    }
    // A failed receipt write leaves sending/unknown. It must never resend.
    await db.prepare(`UPDATE telegram_notices SET state = 'sent', message_id = ?3, updated_at = ?4
      WHERE update_id = ?1 AND generation = ?2 AND state IN ('sending', 'unknown')`).bind(notice.update_id, generation, String(messageId), new Date().toISOString()).run();
    logStructured("telegram_notice_confirmed", { operationMs: Date.now() - Date.parse(notice.created_at), state: "sent" });
  }
  // The client deadline is 10s; an old in-flight outcome stays uncertain.
  const stale = await db.prepare(`UPDATE telegram_notices SET state = 'unknown', updated_at = ?2
    WHERE state = 'sending' AND last_attempt_at_seconds < ?1`).bind(nowSeconds - 60, now.toISOString()).run();
  if (stale.meta.changes) logStructured("telegram_notice_operator_action_required", { state: "unknown" });
}

/** Only bounded, server-generated quality callbacks may enter the durable outbox. */
function parseQualityKeyboard(value: string | null): { inline_keyboard: TelegramInlineKeyboardButton[][] } | undefined {
  if (value === null) return undefined;
  if (value.length > 2048) throw new Error("Invalid quality keyboard");
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Object.keys(parsed).join() !== "inline_keyboard") throw new Error("Invalid quality keyboard");
  const rows = (parsed as { inline_keyboard?: unknown }).inline_keyboard;
  if (!Array.isArray(rows) || rows.length < 2 || rows.length > 5) throw new Error("Invalid quality keyboard");
  const tokens = new Set<string>();
  for (const [index, row] of rows.entries()) {
    if (!Array.isArray(row) || row.length !== 1) throw new Error("Invalid quality keyboard");
    const button: unknown = row[0];
    if (!button || typeof button !== "object") throw new Error("Invalid quality keyboard");
    const fields = button as Record<string, unknown>;
    if (Object.keys(fields).sort().join() !== "callback_data,text" || typeof fields.text !== "string"
      || typeof fields.callback_data !== "string" || !/^vq:[0-9a-f]{32}$/u.test(fields.callback_data)
      || tokens.has(fields.callback_data)) throw new Error("Invalid quality keyboard");
    const label = index === 0 ? /^Automatic \(up to (?:[1-9][0-9]{0,2}|10[0-7][0-9]|1080)p\)$/u
      : index === rows.length - 1 ? /^Cancel$/u : /^Up to (?:720|480|360)p$/u;
    if (!label.test(fields.text)) throw new Error("Invalid quality keyboard");
    tokens.add(fields.callback_data);
  }
  return parsed as { inline_keyboard: TelegramInlineKeyboardButton[][] };
}
