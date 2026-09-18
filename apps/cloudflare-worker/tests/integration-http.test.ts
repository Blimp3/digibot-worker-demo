import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveIntegrationPairing,
  getIntegrationPairingSummary,
  INTEGRATION_AUTH_POLICY,
  type IntegrationSessionCredentials,
} from "../src/integration-auth";
import { handleIntegrationRequest } from "../src/integration";
import { hashIntegrationBytes, INTEGRATION_CHECK_BYTES } from "../src/integration-store";
import { bytesToBase64Url } from "../src/security";
import type { D1BatchDatabaseLike, R2BucketLike, R2ObjectLike } from "../src/types";
import { processIntegrationOperation, type IntegrationEnv, type IntegrationStep } from "../src/integration-media";
import { localD1 } from "./helpers/local-d1";
import { testFixedLengthStream } from "./helpers/fixed-length-stream";

const NOW = Math.floor(Date.now() / 1000);
const OWNER = "12345";
const OTHER = "67890";
const ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const WRONG_PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 4, 5, 6]);
const CREATED_AT = new Date(NOW * 1000).toISOString();

type WorkflowCall = { id: string; params: unknown; retention: unknown };

let db: D1BatchDatabaseLike;
let dispose: () => Promise<void>;
let env: IntegrationEnv;
let objects: Map<string, Uint8Array>;
let providerCalls: Array<{ path: string; accountId: string }>;
let workflowCalls: WorkflowCall[];

const immediateStep: IntegrationStep = {
  do: async (_name, _options, callback) => callback(),
};

function r2Bucket(): R2BucketLike {
  return {
    async get(key): Promise<R2ObjectLike | null> {
      const value = objects.get(key);
      if (!value) return null;
      const copy = new Uint8Array(value.byteLength);
      copy.set(value);
      return { body: new Response(copy.buffer).body, size: copy.byteLength };
    },
    async put(key, value): Promise<void> {
      if (value instanceof Uint8Array) {
        objects.set(key, new Uint8Array(value));
        return;
      }
      const bytes = new Uint8Array(await new Response(value as BodyInit).arrayBuffer());
      objects.set(key, bytes);
    },
    async delete(key): Promise<void> { objects.delete(key); },
    async list(): Promise<{ objects: Array<{ key: string; uploaded?: Date }>; truncated: boolean }> {
      return { objects: [], truncated: false };
    },
  };
}

function gatewayEnv(): IntegrationEnv {
  return {
    DB: db,
    INTEGRATION_ENABLED: "true",
    INTEGRATION_ALLOWED_ORIGINS: ORIGIN,
    PUBLIC_WORKER_BASE_URL: "https://worker.example",
    TELEGRAM_BOT_TOKEN: "123456:test",
    TELEGRAM_WEBHOOK_SECRET: "webhook-secret",
    INTERNAL_CONTAINER_SECRET: "container-secret",
    DOWNLOAD_LINK_HMAC_SECRET: "download-secret",
    ALLOWED_TELEGRAM_USER_IDS: `${OWNER},${OTHER}`,
    ALLOWED_SOURCE_HOSTS: "youtube.com,youtu.be",
    TELEGRAM_BOT_API_BASE: "https://api.telegram.org",
    MAX_TELEGRAM_BYTES: "49000000",
    MEDIA_BUCKET: r2Bucket(),
    PROVENANCE_VERIFIER: {
      fetch: vi.fn(async (request: Request) => {
        const accountId = request.headers.get("x-integration-account-id") ?? "";
        providerCalls.push({ path: new URL(request.url).pathname, accountId });
        if (new URL(request.url).pathname === "/validate") {
          const form = await request.formData();
          return Response.json({
            mediaSha256: form.get("imageSha256"),
            byteLength: Number(form.get("byteLength")),
            mimeType: form.get("validatedMimeType"),
            audioDurationSeconds: null,
          });
        }
        return Response.json({ result: {}, cache: null });
      }),
    },
    INTEGRATION_WORKFLOW: {
      create: vi.fn(async (value: WorkflowCall) => { workflowCalls.push(value); }),
      get: vi.fn(),
    },
  } as unknown as IntegrationEnv;
}

function input(operationId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    operationId,
    action: "check",
    forceRecheck: false,
    media: {
      mediaSha256: hashIntegrationBytes(PNG),
      byteLength: PNG.byteLength,
      mimeType: "image/png",
      inputKind: "original",
      audioDurationSeconds: null,
      segment: null,
      fullSourceSha256: null,
    },
    ...overrides,
  };
}

function request(
  token: string,
  path: string,
  options: { method?: string; body?: BodyInit; contentType?: string; createdAt?: string } = {},
): Request {
  const headers = new Headers({ authorization: `Bearer ${token}` });
  if (options.contentType) headers.set("content-type", options.contentType);
  if (options.createdAt) headers.set("x-integration-created-at", options.createdAt);
  return new Request(`https://worker.example${path}`, { method: options.method ?? "GET", headers, body: options.body });
}

function jsonRequest(token: string, path: string, body: unknown, method = "POST"): Request {
  return request(token, path, {
    method,
    contentType: "application/json",
    createdAt: CREATED_AT,
    body: JSON.stringify(body),
  });
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function authJson(path: string, body: unknown, seed: number): Request {
  return new Request(`https://worker.example${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "cf-connecting-ip": `198.51.100.${seed}`,
    },
    body: JSON.stringify(body),
  });
}

async function pairedSession(telegramUserId: string, seed: number): Promise<IntegrationSessionCredentials> {
  const verifier = bytesToBase64Url(new Uint8Array(32).fill(seed));
  const created = await handleIntegrationRequest(authJson("/api/integration/pairings", {
    verifier, deviceName: `HTTP ${seed}`,
  }, seed), env);
  expect(created?.status).toBe(201);
  const pairing = await responseJson(created!);
  expect(pairing).toMatchObject({
    pairId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
    confirmationCode: expect.stringMatching(/^\d{6}$/u),
  });
  const persistedTiming = await db.prepare("SELECT created_at, expires_at FROM integration_pairings WHERE id = ?1")
    .bind(pairing.pairId as string).first<{ created_at: number; expires_at: number }>();
  if (!persistedTiming) throw new Error("Expected pairing timing row");
  expect(persistedTiming.expires_at - persistedTiming.created_at).toBe(INTEGRATION_AUTH_POLICY.pairingTtlSeconds);
  expect(pairing.expiresAt).toBe(new Date(persistedTiming.expires_at * 1000).toISOString());
  expect(pairing).not.toHaveProperty("ok");
  expect(pairing).not.toHaveProperty("pairing");
  const summary = await getIntegrationPairingSummary(env, {
    pairId: pairing.pairId as string, telegramUserId, privateChatId: telegramUserId,
  }, NOW);
  expect(summary?.confirmationCode).toBe(pairing.confirmationCode);
  await expect(approveIntegrationPairing(env, {
    pairId: pairing.pairId as string,
    confirmationCode: pairing.confirmationCode as string,
    telegramUserId,
    privateChatId: telegramUserId,
  }, NOW)).resolves.toMatchObject({ telegramUserId });
  const exchanged = await handleIntegrationRequest(authJson(
    `/api/integration/pairings/${pairing.pairId as string}/exchange`, { verifier }, seed), env);
  expect(exchanged?.status).toBe(200);
  const session = await responseJson(exchanged!);
  expect(session).toMatchObject({
    tokenType: "Bearer",
    accountId: expect.any(String),
    sessionId: expect.any(String),
    accessToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
    refreshToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u),
  });
  expect(session).not.toHaveProperty("ok");
  expect(session).not.toHaveProperty("session");
  return session as unknown as IntegrationSessionCredentials;
}

beforeAll(async () => {
  ({ db, dispose } = await localD1());
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
  objects = new Map();
  providerCalls = [];
  workflowCalls = [];
  testFixedLengthStream();
  env = gatewayEnv();
});

afterAll(async () => {
  await dispose();
  vi.unstubAllGlobals();
});

describe("authenticated integration HTTP gateway", () => {
  it("registers, uploads, queues, replays, and conflicts through the real session boundary", async () => {
    const session = await pairedSession(OWNER, 1);
    const operationId = "11111111-1111-4111-8111-111111111111";
    const body = input(operationId);

    const registered = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", body), env);
    expect(registered?.status).toBe(201);
    expect(await responseJson(registered!)).toMatchObject({ operationId, state: "awaiting_upload" });

    const uploaded = await handleIntegrationRequest(request(session.accessToken, `/api/integration/operations/${operationId}/media`, {
      method: "PUT", contentType: "image/png", body: new Blob([PNG], { type: "image/png" }),
    }), env);
    expect(uploaded?.status).toBe(202);
    expect(await responseJson(uploaded!)).toMatchObject({ operationId, state: "queued" });
    expect(providerCalls.map((call) => call.path)).toEqual(["/validate"]);
    expect(workflowCalls).toHaveLength(1);
    expect(workflowCalls[0]).toMatchObject({ retention: { successRetention: "1 day", errorRetention: "1 day" } });

    const replay = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", body), env);
    expect(replay?.status).toBe(200);
    expect(await responseJson(replay!)).toMatchObject({ operationId, state: "queued" });
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_operations WHERE id = ?1").bind(operationId).first()).toEqual({ count: 1 });

    const changed = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input(operationId, { forceRecheck: true })), env);
    expect(changed?.status).toBe(409);
    expect(await responseJson(changed!)).toMatchObject({ error: { code: "operation_conflict" } });
  });

  it("preserves deliberate Download outcomes when its Telegram copy is deleted", async () => {
    const session = await pairedSession(OWNER, 8);
    const mediaSha256 = hashIntegrationBytes(PNG);
    let sendFailure = false;
    const telegramFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sendDocument")) {
        await new Response(init?.body).arrayBuffer();
        if (sendFailure) return Response.json({ ok: false, error_code: 400, description: "rejected" }, { status: 400 });
        return Response.json({ ok: true, result: { message_id: 501, chat: { id: 12345 }, document: { file_id: "saved-file-501" } } });
      }
      if (url.endsWith("/getFile")) {
        return Response.json({ ok: true, result: { file_id: "saved-file-501", file_path: "documents/saved.png", file_size: PNG.byteLength } });
      }
      if (url.includes("/file/bot")) return new Response(PNG.slice());
      if (url.endsWith("/deleteMessage")) return Response.json({ ok: true, result: true });
      throw new Error(`Unexpected Telegram request: ${url}`);
    });
    vi.stubGlobal("fetch", telegramFetch as unknown as typeof fetch);

    try {
      const operationId = "77777777-7777-4777-8777-777777777777";
      const registered = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input(operationId, { action: "download" })), env);
      expect(registered?.status).toBe(201);
      const uploaded = await handleIntegrationRequest(request(session.accessToken, `/api/integration/operations/${operationId}/media`, {
        method: "PUT", contentType: "image/png", body: new Blob([PNG], { type: "image/png" }),
      }), env);
      expect(uploaded?.status).toBe(202);
      const queued = await db.prepare("SELECT run_generation FROM integration_operations WHERE id = ?1 AND account_id = ?2")
        .bind(operationId, session.accountId).first<{ run_generation: number }>();
      await processIntegrationOperation(env, { accountId: session.accountId, operationId, generation: queued?.run_generation ?? 0 }, immediateStep);
      expect(providerCalls).toHaveLength(0);

      const before = await handleIntegrationRequest(request(session.accessToken, "/api/integration/stats"), env);
      expect(await responseJson(before!)).toMatchObject({ downloadsRequested: 1, downloadsConfirmed: 1, downloadsFailed: 0, savedOriginals: 1 });

      const deleted = await handleIntegrationRequest(request(session.accessToken, `/api/integration/media/${mediaSha256}/archive`, { method: "DELETE" }), env);
      expect(deleted?.status).toBe(200);
      const afterDelete = await handleIntegrationRequest(request(session.accessToken, "/api/integration/stats"), env);
      expect(await responseJson(afterDelete!)).toMatchObject({ downloadsRequested: 1, downloadsConfirmed: 1, downloadsFailed: 0, savedOriginals: 0 });
      const history = await handleIntegrationRequest(request(session.accessToken, "/api/integration/history?period=all"), env);
      expect(await responseJson(history!)).toMatchObject({
        operations: [expect.objectContaining({
          operationId,
          state: "completed",
          archive: expect.objectContaining({
            deliveryState: "failed",
            documentReceipt: null,
            integrityState: "not_checked",
            error: expect.objectContaining({ code: "archive_deleted" }),
          }),
        })],
      });

      sendFailure = true;
      const failedOperationId = "88888888-8888-4888-8888-888888888888";
      const failedRegistered = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input(failedOperationId, { action: "download" })), env);
      expect(failedRegistered?.status).toBe(201);
      const failedUploaded = await handleIntegrationRequest(request(session.accessToken, `/api/integration/operations/${failedOperationId}/media`, {
        method: "PUT", contentType: "image/png", body: new Blob([PNG], { type: "image/png" }),
      }), env);
      expect(failedUploaded?.status).toBe(202);
      const failedQueued = await db.prepare("SELECT run_generation FROM integration_operations WHERE id = ?1 AND account_id = ?2")
        .bind(failedOperationId, session.accountId).first<{ run_generation: number }>();
      await processIntegrationOperation(env, { accountId: session.accountId, operationId: failedOperationId, generation: failedQueued?.run_generation ?? 0 }, immediateStep);

      const afterFailure = await handleIntegrationRequest(request(session.accessToken, "/api/integration/stats"), env);
      expect(await responseJson(afterFailure!)).toMatchObject({ downloadsRequested: 2, downloadsConfirmed: 1, downloadsFailed: 1, savedOriginals: 0 });
      expect(telegramFetch.mock.calls.filter(([input]) => String(input).endsWith("/sendDocument"))).toHaveLength(2);
      expect(telegramFetch.mock.calls.filter(([input]) => String(input).endsWith("/deleteMessage"))).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps every operation endpoint account-scoped", async () => {
    const owner = await pairedSession(OWNER, 2);
    const other = await pairedSession(OTHER, 3);
    const operationId = "22222222-2222-4222-8222-222222222222";
    const registered = await handleIntegrationRequest(jsonRequest(owner.accessToken, "/api/integration/operations", input(operationId)), env);
    expect(registered?.status).toBe(201);
    const mediaPath = `/api/integration/operations/${operationId}/media`;
    const operationPath = `/api/integration/operations/${operationId}`;

    for (const response of [
      await handleIntegrationRequest(request(other.accessToken, operationPath), env),
      await handleIntegrationRequest(request(other.accessToken, mediaPath, { method: "PUT", contentType: "image/png", body: new Blob([PNG], { type: "image/png" }) }), env),
      await handleIntegrationRequest(request(other.accessToken, `${operationPath}/retry`, { method: "POST" }), env),
      await handleIntegrationRequest(request(other.accessToken, `/api/integration/history/${operationId}`, { method: "DELETE" }), env),
    ]) {
      expect(response?.status).toBe(404);
      expect(await responseJson(response!)).toMatchObject({ error: { code: "not_found" } });
    }
    expect((await handleIntegrationRequest(request(owner.accessToken, operationPath), env))?.status).toBe(200);
    expect(await db.prepare("SELECT deleted_at FROM integration_operations WHERE id = ?1").bind(operationId).first()).toEqual({ deleted_at: null });
  });

  it("denies expired and revoked device sessions before reading account data", async () => {
    const expired = await pairedSession(OWNER, 4);
    await db.prepare("UPDATE integration_sessions SET access_expires_at = ?1 WHERE id = ?2").bind(NOW - 1, expired.sessionId).run();
    const expiredResponse = await handleIntegrationRequest(request(expired.accessToken, "/api/integration/history"), env);
    expect(expiredResponse?.status).toBe(401);
    expect(await responseJson(expiredResponse!)).toMatchObject({ error: { code: "UNAUTHORIZED" } });

    const revoked = await pairedSession(OTHER, 5);
    await db.prepare("UPDATE integration_sessions SET revoked_at = ?1 WHERE id = ?2").bind(NOW, revoked.sessionId).run();
    const revokedResponse = await handleIntegrationRequest(request(revoked.accessToken, "/api/integration/history"), env);
    expect(revokedResponse?.status).toBe(401);
    expect(await responseJson(revokedResponse!)).toMatchObject({ error: { code: "UNAUTHORIZED" } });
  });

  it("registers processing-only audio as a Check without verifier/provider access", async () => {
    const session = await pairedSession(OWNER, 6);
    const response = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/audio-segments", {
      operationId: "33333333-3333-4333-8333-333333333333",
      sourceUrl: "https://youtube.com/watch?v=abc",
      startSeconds: 0,
      endSeconds: 15,
    }), env);
    expect(response?.status).toBe(202);
    expect(await responseJson(response!)).toMatchObject({ action: "check", state: "queued" });
    expect(await db.prepare("SELECT action, admitted_at FROM integration_operations WHERE id = ?1")
      .bind("33333333-3333-4333-8333-333333333333").first()).toMatchObject({ action: "check", admitted_at: expect.any(String) });
    const stats = await handleIntegrationRequest(request(session.accessToken, "/api/integration/stats"), env);
    expect(stats?.status).toBe(200);
    expect(await responseJson(stats!)).toMatchObject({ checksRequested: 1, downloadsRequested: 0 });
    expect(providerCalls).toHaveLength(0);
    expect(workflowCalls).toHaveLength(1);
  });

  it("rejects unsupported, oversized, and hash-mismatched checks before admission", async () => {
    const session = await pairedSession(OWNER, 7);
    const unsupported = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input("44444444-4444-4444-8444-444444444444", {
      media: { ...(input("55555555-5555-4555-8555-555555555555").media as Record<string, unknown>), mimeType: "image/gif" },
    })), env);
    expect(unsupported?.status).toBe(400);

    const oversized = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input("55555555-5555-4555-8555-555555555555", {
      media: { ...(input("66666666-6666-4666-8666-666666666666").media as Record<string, unknown>), byteLength: INTEGRATION_CHECK_BYTES + 1 },
    })), env);
    expect(oversized?.status).toBe(400);
    expect(await db.prepare("SELECT COUNT(*) AS count FROM integration_operations").first()).toEqual({ count: 0 });

    const operationId = "66666666-6666-4666-8666-666666666666";
    const registered = await handleIntegrationRequest(jsonRequest(session.accessToken, "/api/integration/operations", input(operationId)), env);
    expect(registered?.status).toBe(201);
    const path = `/api/integration/operations/${operationId}/media`;
    const mismatch = await handleIntegrationRequest(request(session.accessToken, path, {
      method: "PUT", contentType: "image/png", body: new Blob([WRONG_PNG], { type: "image/png" }),
    }), env);
    expect(mismatch?.status).toBe(400);
    expect(await responseJson(mismatch!)).toMatchObject({ error: { code: "hash_mismatch" } });

    const tooLarge = await handleIntegrationRequest(request(session.accessToken, path, {
      method: "PUT", contentType: "image/png", body: new Blob([new Uint8Array([...PNG, 7])], { type: "image/png" }),
    }), env);
    expect(tooLarge?.status).toBe(413);
    const operation = await db.prepare("SELECT status, admitted_at, temp_key FROM integration_operations WHERE id = ?1")
      .bind(operationId).first<{ status: string; admitted_at: string | null; temp_key: string | null }>();
    expect(operation).toEqual({ status: "awaiting_upload", admitted_at: null, temp_key: null });
    expect(providerCalls).toHaveLength(0);
    expect(objects.size).toBe(0);
  });
});
