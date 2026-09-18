import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntegrationInvitation, createIntegrationPairing, integrationAccountForTelegram } from "../src/integration-auth";
import { attachIntegrationMedia, hashIntegrationBytes, registerIntegrationOperation, type IntegrationInput } from "../src/integration-store";
import { handleIntegrationTelegramUpdate, deterministicUUID } from "../src/integration-telegram";
import { bytesToBase64Url } from "../src/security";
import { localD1 } from "./helpers/local-d1";
import type { D1BatchDatabaseLike, R2BucketLike, R2ObjectLike, TelegramUpdate } from "../src/types";
import type { IntegrationEnv } from "../src/integration-media";

const OWNER = "12345";
const INVITED = "67890";
const LEGACY_SECOND = "67891";
const BOT_ID = 999;
const NOW = Math.floor(Date.now() / 1000);
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

type TelegramCall = { url: string; body: unknown };

let database: Awaited<ReturnType<typeof localD1>>;
let db: D1BatchDatabaseLike;
let env: IntegrationEnv;
let telegramCalls: TelegramCall[];
let workflowCalls: Array<{ id: string; params: unknown }>;
let objects: Map<string, Uint8Array>;
let sourceBytes: Uint8Array;
let failDelete = false;

function requestUpdate(update: TelegramUpdate): TelegramUpdate {
  return update;
}

function message(updateId: number, userId: string, text: string, extra: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      from: { id: Number(userId) },
      chat: { id: Number(userId), type: "private" },
      text,
      ...extra,
    },
  };
}

function replyDocument(userId = OWNER, fileId = "incoming-image"): Record<string, unknown> {
  return {
    message_id: 700,
    from: { id: Number(userId) },
    chat: { id: Number(userId), type: "private" },
    document: { file_id: fileId, file_size: sourceBytes.byteLength, mime_type: "image/gif", file_name: "claimed.gif" },
  };
}

function bucket(): R2BucketLike {
  return {
    async get(key): Promise<R2ObjectLike | null> {
      const value = objects.get(key);
      return value ? { body: new Response(new Blob([new Uint8Array(value)])).body, size: value.byteLength } : null;
    },
    async put(key, value): Promise<void> {
      if (value instanceof Uint8Array) objects.set(key, new Uint8Array(value));
      else if (value instanceof ArrayBuffer) objects.set(key, new Uint8Array(value.slice(0)));
      else if (value instanceof Blob) objects.set(key, new Uint8Array(await value.arrayBuffer()));
      else objects.set(key, new Uint8Array(await new Response(value).arrayBuffer()));
    },
    async delete(key): Promise<void> {
      if (failDelete) throw new Error("synthetic R2 delete failure");
      objects.delete(key);
    },
  };
}

function telegramResult(url: string): Response {
  if (url.endsWith("/getMe")) return Response.json({ ok: true, result: { id: BOT_ID, username: "DigiBot" } });
  if (url.endsWith("/getFile")) return Response.json({ ok: true, result: { file_path: "photos/incoming.png", file_size: sourceBytes.byteLength } });
  if (url.includes("/file/bot")) return new Response(sourceBytes.slice());
  if (url.endsWith("/sendMessage")) return Response.json({ ok: true, result: { message_id: 800 + telegramCalls.length, chat: { id: Number(OWNER) } } });
  if (url.endsWith("/answerCallbackQuery") || url.endsWith("/editMessageReplyMarkup")) return Response.json({ ok: true, result: true });
  if (url.endsWith("/sendDocument")) return Response.json({ ok: true, result: { message_id: 900, chat: { id: Number(OWNER) }, document: { file_id: "sent-document" } } });
  return Response.json({ ok: true, result: true });
}

function testEnvironment(): IntegrationEnv {
  return {
    DB: db,
    TELEGRAM_BOT_TOKEN: "bot-token",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    INTERNAL_CONTAINER_SECRET: "internal-secret",
    DOWNLOAD_LINK_HMAC_SECRET: "download-hmac",
    ALLOWED_TELEGRAM_USER_IDS: `${OWNER},${LEGACY_SECOND}`,
    ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be",
    TELEGRAM_BOT_API_BASE: "https://api.telegram.org",
    INTEGRATION_ENABLED: "true",
    PUBLIC_WORKER_BASE_URL: "https://worker.example",
    MEDIA_BUCKET: bucket(),
    PROVENANCE_VERIFIER: {
      fetch: vi.fn(async (request: Request) => {
        const form = await request.formData();
        return Response.json({
          mediaSha256: form.get("imageSha256"),
          byteLength: Number(form.get("byteLength")),
          mimeType: form.get("validatedMimeType"),
          audioDurationSeconds: null,
        });
      }),
    },
    INTEGRATION_WORKFLOW: {
      create: vi.fn(async (value: { id: string; params: unknown }) => { workflowCalls.push(value); }),
      get: vi.fn(),
    },
  } as unknown as IntegrationEnv;
}

beforeAll(async () => {
  database = await localD1();
  db = database.db;
}, 30_000);

afterAll(async () => {
  await database?.dispose();
  vi.unstubAllGlobals();
});

beforeEach(async () => {
  await db.batch([
    db.prepare("DELETE FROM integration_sessions"),
    db.prepare("DELETE FROM integration_pairing_claims"),
    db.prepare("DELETE FROM integration_pairings"),
    db.prepare("DELETE FROM integration_invitation_claims"),
    db.prepare("DELETE FROM integration_invitations"),
    db.prepare("DELETE FROM integration_rate_limits"),
    db.prepare("DELETE FROM integration_operations"),
    db.prepare("DELETE FROM integration_archives"),
    db.prepare("DELETE FROM integration_media"),
    db.prepare("DELETE FROM integration_accounts"),
  ]);
  telegramCalls = [];
  workflowCalls = [];
  objects = new Map();
  sourceBytes = PNG.slice();
  failDelete = false;
  env = testEnvironment();
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    let body: unknown = init?.body;
    if (typeof body === "string") {
      try { body = JSON.parse(body); } catch { /* multipart bodies stay opaque in this test. */ }
    }
    telegramCalls.push({ url, body });
    return telegramResult(url);
  }));
});

describe("Telegram integration admission and image checks", () => {
  it("shows bounded shared History with evidence and offers an explicit check for a bare image", async () => {
    const prompt = await handleIntegrationTelegramUpdate(message(90, OWNER, "", { photo: [{ file_id: "incoming-image" }] }), env);
    expect(await prompt?.json()).toMatchObject({ checkAvailable: true });
    expect(workflowCalls).toHaveLength(0);
    for (let index = 0; index < 6; index++) {
      await handleIntegrationTelegramUpdate(message(100 + index, OWNER, "/check", { reply_to_message: replyDocument() }), env);
      await db.prepare("UPDATE integration_operations SET reserved_bytes = 0").run();
    }
    await db.prepare("UPDATE integration_operations SET result_json = ?1, status = 'completed'").bind(JSON.stringify({
      cacheSource: "server_cache", originallyCheckedAt: "2026-09-16T10:00:00.000Z",
      evidence: { summary: "No supported provenance signal was detected." },
    })).run();
    await handleIntegrationTelegramUpdate(message(110, OWNER, "/history"), env);
    const last = telegramCalls.filter((call) => call.url.endsWith("/sendMessage")).at(-1)?.body as {
      text: string; reply_markup: { inline_keyboard: Array<Array<{ web_app: { url: string } }>> };
    };
    expect(last.text.match(/State:/gu)).toHaveLength(5);
    expect(last.text.length).toBeLessThan(4096);
    expect(last.text).toContain("No supported provenance signal was detected.");
    expect(last.text).toContain("server_cache; checked 2026-09-16T10:00:00.000Z");
    expect(last.reply_markup.inline_keyboard[0]?.[0]?.web_app.url).toBe("https://worker.example/apps/downloader?view=integration");
  });

  it("does nothing when the integration flag is disabled", async () => {
    expect(await handleIntegrationTelegramUpdate(message(1, OWNER, "/history"), { ...env, INTEGRATION_ENABLED: "false" })).toBeNull();
    expect(telegramCalls).toHaveLength(0);
  });

  it("admits one-use invitations and keeps invited users out of legacy commands", async () => {
    const invitation = await createIntegrationInvitation(env, { issuerTelegramUserId: OWNER }, NOW);
    if (!invitation) throw new Error("Expected invitation");
    const admitted = await handleIntegrationTelegramUpdate(message(1, INVITED, `/start ${invitation.inviteToken}`), env);
    expect(await admitted?.json()).toMatchObject({ admitted: true });
    expect(await db.prepare("SELECT admission_source FROM integration_accounts WHERE telegram_user_id = ?1").bind(INVITED).first()).toEqual({ admission_source: "invitation" });

    const blocked = await handleIntegrationTelegramUpdate(message(2, INVITED, "/help"), env);
    expect(await blocked?.json()).toMatchObject({ accepted: false, error: "INTEGRATION_COMMAND_REQUIRED" });
  });

  it("shows a pairing code and approves only the matching private callback", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const verifier = bytesToBase64Url(new Uint8Array(32).fill(4));
    const pairing = await createIntegrationPairing(env, { verifier, deviceName: "Lens" }, NOW);
    const linked = await handleIntegrationTelegramUpdate(message(10, OWNER, `/link ${pairing.pairId}`), env);
    expect(await linked?.json()).toMatchObject({ pairing: pairing.pairId });
    const sent = telegramCalls.find((call) => call.url.endsWith("/sendMessage"));
    const callbackData = (sent?.body as { reply_markup?: { inline_keyboard?: Array<Array<{ callback_data?: string }>> } })?.reply_markup?.inline_keyboard?.[0]?.[0]?.callback_data;
    expect(callbackData).toMatch(/^ia:approve:/u);
    const callback = await handleIntegrationTelegramUpdate(requestUpdate({
      update_id: 11,
      callback_query: {
        id: "callback-1",
        from: { id: Number(OWNER) },
        data: callbackData,
        message: { message_id: 88, chat: { id: Number(OWNER), type: "private" } },
      },
    }), env);
    expect(await callback?.json()).toMatchObject({ approved: true });
    expect(await db.prepare("SELECT approved_account_id FROM integration_pairings WHERE id = ?1").bind(pairing.pairId).first()).toMatchObject({ approved_account_id: account.accountId });
  });

  it("checks exact document and photo bytes while ignoring claimed MIME metadata", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const documentResult = await handleIntegrationTelegramUpdate(message(20, OWNER, "/check", { reply_to_message: replyDocument() }), env);
    expect(await documentResult?.json()).toMatchObject({ accepted: true });
    const documentNotice = telegramCalls.filter((call) => call.url.endsWith("/sendMessage")).at(-1);
    expect((documentNotice?.body as { text?: string })?.text).toMatch(/exact Telegram document bytes/iu);
    const documentId = deterministicUUID(account.accountId, 20);
    const documentInput = await db.prepare("SELECT input_json FROM integration_operations WHERE account_id = ?1 AND id = ?2").bind(account.accountId, documentId).first<{ input_json: string }>();
    expect(JSON.parse(documentInput!.input_json)).toMatchObject({ media: { mimeType: "image/png", inputKind: "original", mediaSha256: hashIntegrationBytes(PNG) } });
    const callsAfterFirstCheck = telegramCalls.length;
    const duplicate = await handleIntegrationTelegramUpdate(message(20, OWNER, "/check", { reply_to_message: replyDocument() }), env);
    expect(await duplicate?.json()).toMatchObject({ duplicate: true, operationId: documentId });
    expect(telegramCalls).toHaveLength(callsAfterFirstCheck);

    const help = await handleIntegrationTelegramUpdate(message(22, OWNER, "/check"), env);
    expect(await help?.json()).toMatchObject({ accepted: false, error: "INVALID_MEDIA" });
    const helpNotice = telegramCalls.filter((call) => call.url.endsWith("/sendMessage")).at(-1);
    expect((helpNotice?.body as { text?: string })?.text).toMatch(/configured provider|Zero Data Retention|AI-generated/iu);

    const photoResult = await handleIntegrationTelegramUpdate(message(21, OWNER, "/check", {
      reply_to_message: {
        message_id: 701,
        chat: { id: Number(OWNER), type: "private" },
        photo: [{ file_id: "small-photo", width: 10, height: 10 }, { file_id: "large-photo", width: 100, height: 100 }],
      },
    }), env);
    expect(await photoResult?.json()).toMatchObject({ accepted: true });
    const photoInput = await db.prepare("SELECT input_json FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, deterministicUUID(account.accountId, 21)).first<{ input_json: string }>();
    expect(JSON.parse(photoInput!.input_json)).toMatchObject({ media: { inputKind: "telegram_photo_copy", mimeType: "image/png" } });
    const photoNotice = telegramCalls.filter((call) => call.url.endsWith("/sendMessage")).at(-1);
    expect((photoNotice?.body as { text?: string })?.text).toMatch(/Telegram photo copy/iu);
    expect(workflowCalls).toHaveLength(2);
    expect(objects.get(`integration/${account.accountId}/${documentId}/telegram-image`)).toEqual(PNG);
  });

  it("does not auto-check an image caption and rejects bytes over 4 MiB", async () => {
    await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    expect(await handleIntegrationTelegramUpdate(message(30, OWNER, "", {
      caption: "/check",
      photo: [{ file_id: "caption-photo", width: 100, height: 100 }],
    }), env)).toBeNull();
    sourceBytes = new Uint8Array(4 * 1024 * 1024 + 1);
    const oversized = await handleIntegrationTelegramUpdate(message(31, OWNER, "/check", { reply_to_message: replyDocument(OWNER, "too-large") }), env);
    expect(await oversized?.json()).toMatchObject({ accepted: false, error: "INVALID_MEDIA" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_operations").first()).toEqual({ count: 0 });
  });

  it("does not replay or expose a deleted action when the Telegram update is redelivered", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const updateId = 32;
    const operationId = deterministicUUID(account.accountId, updateId);
    const input: IntegrationInput = {
      version: 1, operationId, action: "check", forceRecheck: false,
      media: { mediaSha256: hashIntegrationBytes(PNG), byteLength: PNG.byteLength, mimeType: "image/png", inputKind: "original", audioDurationSeconds: null, segment: null, fullSourceSha256: null },
    };
    await registerIntegrationOperation(db, account, { input }, new Date().toISOString());
    await db.prepare(`UPDATE integration_operations SET deleted_at = ?1, input_json = NULL, result_json = NULL,
      source_cipher = NULL, segment_json = NULL, error_json = NULL WHERE account_id = ?2 AND id = ?3`)
      .bind(new Date().toISOString(), account.accountId, operationId).run();
    const before = telegramCalls.length;
    const result = await handleIntegrationTelegramUpdate(message(updateId, OWNER, "/check", { reply_to_message: replyDocument() }), env);
    expect(await result?.json()).toMatchObject({ accepted: false, error: "OPERATION_DELETED" });
    expect(telegramCalls.slice(before).filter((call) => call.url.endsWith("/getFile"))).toHaveLength(0);
    const notice = telegramCalls.slice(before).find((call) => call.url.endsWith("/sendMessage"));
    expect((notice?.body as { text?: string })?.text).toMatch(/action was deleted/iu);
  });

  it("reconciles only a current-bot document whose downloaded bytes match the archive", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const operationId = "11111111-1111-4111-8111-111111111111";
    const input: IntegrationInput = {
      version: 1, operationId, action: "check", forceRecheck: false,
      media: { mediaSha256: hashIntegrationBytes(PNG), byteLength: PNG.byteLength, mimeType: "image/png", inputKind: "original", audioDurationSeconds: null, segment: null, fullSourceSha256: null },
    };
    const operation = await registerIntegrationOperation(db, account, { input }, new Date().toISOString());
    await attachIntegrationMedia(db, operation, input, `integration/${account.accountId}/${operationId}/telegram-image`, new Date());
    await db.prepare("UPDATE integration_operations SET status = 'failed' WHERE account_id = ?1 AND id = ?2").bind(account.accountId, operationId).run();
    await db.prepare("UPDATE integration_archives SET delivery_state = 'unknown' WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, hashIntegrationBytes(`${account.accountId}\0${input.media.mediaSha256}`)).run();

    const result = await handleIntegrationTelegramUpdate(message(40, OWNER, `/reconcile ${operationId}`, {
      reply_to_message: {
        message_id: 901,
        from: { id: BOT_ID, is_bot: true },
        chat: { id: Number(OWNER), type: "private" },
        document: { file_id: "saved-document", file_size: PNG.byteLength },
      },
    }), env);
    expect(await result?.json()).toMatchObject({ accepted: true, reconciled: true });
    const archive = await db.prepare("SELECT delivery_state, integrity_state, round_trip_sha256, receipt_json FROM integration_archives WHERE account_id = ?1")
      .bind(account.accountId).first<{ delivery_state: string; integrity_state: string; round_trip_sha256: string; receipt_json: string }>();
    expect(archive).toMatchObject({ delivery_state: "confirmed", integrity_state: "verified", round_trip_sha256: hashIntegrationBytes(PNG) });
    expect(JSON.parse(archive!.receipt_json)).toMatchObject({ botId: String(BOT_ID), chatId: OWNER, messageId: "901", fileId: "saved-document" });
    const unrepairedCheck = await db.prepare("SELECT status, error_json, temp_key, reserved_bytes FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, operationId).first<{ status: string; error_json: string | null; temp_key: string | null; reserved_bytes: number }>();
    expect(unrepairedCheck).toMatchObject({ status: "failed", temp_key: `integration/${account.accountId}/${operationId}/telegram-image` });
    expect(unrepairedCheck?.error_json).toBeNull();
    expect(unrepairedCheck?.reserved_bytes).toBeGreaterThan(0);
    expect(telegramCalls.some((call) => call.url.endsWith("/sendDocument"))).toBe(false);
  });

  it("repairs a reconciled download and releases its reservation only after the R2 delete", async () => {
    const account = await integrationAccountForTelegram(env, { telegramUserId: OWNER, privateChatId: OWNER }, NOW);
    if (!account) throw new Error("Expected owner account");
    const operationId = "22222222-2222-4222-8222-222222222222";
    const input: IntegrationInput = {
      version: 1, operationId, action: "download", forceRecheck: false,
      media: { mediaSha256: hashIntegrationBytes(PNG), byteLength: PNG.byteLength, mimeType: "image/png", inputKind: "original", audioDurationSeconds: null, segment: null, fullSourceSha256: null },
    };
    const operation = await registerIntegrationOperation(db, account, { input }, new Date().toISOString());
    const tempKey = `integration/${account.accountId}/${operationId}/telegram-image`;
    await attachIntegrationMedia(db, operation, input, tempKey, new Date());
    await env.MEDIA_BUCKET.put(tempKey, PNG);
    await db.prepare("UPDATE integration_operations SET status = 'failed', error_json = ?1 WHERE account_id = ?2 AND id = ?3")
      .bind(JSON.stringify({ code: "archive_unknown", message: "Delivery was uncertain.", retryable: false }), account.accountId, operationId).run();
    await db.prepare("UPDATE integration_archives SET delivery_state = 'unknown' WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, hashIntegrationBytes(`${account.accountId}\0${input.action === "download" ? operationId : input.media.mediaSha256}`)).run();

    failDelete = true;
    const result = await handleIntegrationTelegramUpdate(message(41, OWNER, `/reconcile ${operationId}`, {
      reply_to_message: {
        message_id: 902,
        from: { id: BOT_ID, is_bot: true },
        chat: { id: Number(OWNER), type: "private" },
        document: { file_id: "saved-download", file_size: PNG.byteLength },
      },
    }), env);
    expect(await result?.json()).toMatchObject({ accepted: true, reconciled: true });
    const retained = await db.prepare("SELECT status, error_json, temp_key, reserved_bytes FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, operationId).first<{ status: string; error_json: string | null; temp_key: string | null; reserved_bytes: number }>();
    expect(retained).toMatchObject({ status: "completed", error_json: null, temp_key: tempKey });
    expect(retained?.reserved_bytes).toBeGreaterThan(0);
    expect(objects.has(tempKey)).toBe(true);

    failDelete = false;
    const retried = await handleIntegrationTelegramUpdate(message(42, OWNER, `/reconcile ${operationId}`, {
      reply_to_message: {
        message_id: 902,
        from: { id: BOT_ID, is_bot: true },
        chat: { id: Number(OWNER), type: "private" },
        document: { file_id: "saved-download", file_size: PNG.byteLength },
      },
    }), env);
    expect(await retried?.json()).toMatchObject({ accepted: true, reconciled: true });
    const repaired = await db.prepare("SELECT status, error_json, temp_key, reserved_bytes FROM integration_operations WHERE account_id = ?1 AND id = ?2")
      .bind(account.accountId, operationId).first<{ status: string; error_json: string | null; temp_key: string | null; reserved_bytes: number }>();
    expect(repaired).toEqual({ status: "completed", error_json: null, temp_key: null, reserved_bytes: 0 });
    expect(objects.has(tempKey)).toBe(false);
  });
});
