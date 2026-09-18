import { readIntegrationBytes, readIntegrationJson } from "./integration-io";
import { decryptSourceUrl } from "./crypto";
import {
  IntegrationFailure, hashIntegrationBytes, integrationSegment,
  type IntegrationInput, type IntegrationOperation, type IntegrationSegment,
} from "./integration-store";
import type { ContainerNamespaceLike, Env, R2BucketLike } from "./types";

const INTEGRATION_AUDIO_MAX_BYTES = 4 * 1024 * 1024;
const INTEGRATION_AUDIO_MAX_DURATION_SECONDS = 60;
const INTEGRATION_AUDIO_TIMEOUT_MS = 20 * 60 * 1000;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export type IntegrationAudioEnv = Env & {
  DOWNLOADER_CONTAINER?: ContainerNamespaceLike;
  MEDIA_BUCKET?: R2BucketLike;
};

export type IntegrationAudioOperation = Pick<IntegrationOperation, "account_id" | "id" | "source_cipher" | "segment_json" | "expires_at">;

interface ContainerAudioMetadata {
  mediaSha256: string;
  byteLength: number;
  durationSeconds: number;
}

function fail(message: string, status = 400, retryable = false): IntegrationFailure {
  return new IntegrationFailure(status, status >= 500 ? "extraction_unavailable" : "invalid_audio", message, retryable);
}

function operationSegment(operation: IntegrationAudioOperation): IntegrationSegment {
  if (!operation.segment_json) throw fail("The audio segment is missing.");
  let parsed: unknown;
  try { parsed = JSON.parse(operation.segment_json) as unknown; }
  catch { throw fail("The audio segment is invalid."); }
  const segment = integrationSegment(parsed);
  if (!segment) throw fail("The audio segment is invalid.");
  return segment;
}

function validateOperation(operation: IntegrationAudioOperation): IntegrationSegment {
  if (!SAFE_ID.test(operation.account_id) || !SAFE_ID.test(operation.id) || !operation.source_cipher) {
    throw fail("The audio operation is invalid.");
  }
  const expiry = Date.parse(operation.expires_at);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new IntegrationFailure(410, "operation_expired", "This audio operation has expired.");
  return operationSegment(operation);
}

async function readAudioResponse(response: Response): Promise<{ bytes: Uint8Array; metadata: ContainerAudioMetadata }> {
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "audio/mpeg") throw fail("The audio extractor returned an invalid media type.", 503, true);
  const body = response.body;
  if (!body) throw fail("The audio extractor returned no media.", 503, true);
  const expectedLength = Number(response.headers.get("x-digibot-media-byte-length") ?? "");
  const durationSeconds = Number(response.headers.get("x-digibot-media-duration-seconds") ?? "");
  const reportedSha = response.headers.get("x-digibot-media-sha256") ?? "";
  if (!Number.isSafeInteger(expectedLength) || expectedLength <= 0 || expectedLength > INTEGRATION_AUDIO_MAX_BYTES
    || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > INTEGRATION_AUDIO_MAX_DURATION_SECONDS
    || !SHA256.test(reportedSha)) throw fail("The audio extractor returned invalid media metadata.", 503, true);
  const bytes = await readIntegrationBytes(response, INTEGRATION_AUDIO_MAX_BYTES);
  const length = bytes.byteLength;
  if (length !== expectedLength) throw fail("The extracted audio length changed.");
  if (hashIntegrationBytes(bytes) !== reportedSha) throw fail("The extracted audio hash changed.");
  return { bytes, metadata: { mediaSha256: reportedSha, byteLength: length, durationSeconds } };
}

function containerFor(env: IntegrationAudioEnv): { fetch(request: Request): Promise<Response> } {
  const namespace = env.DOWNLOADER_CONTAINER as ContainerNamespaceLike | undefined;
  const stub = namespace?.getByName?.("personal");
  if (!stub) throw fail("The audio extractor is unavailable.", 503, true);
  return stub;
}

/**
 * Extract a selected source segment in the private downloader container and
 * retain only the bounded derived bytes in the account-scoped integration R2
 * namespace. The source URL never enters the returned input or the object key.
 */
export async function prepareIntegrationAudio(
  env: IntegrationAudioEnv,
  operation: IntegrationAudioOperation,
): Promise<{ input: IntegrationInput; tempKey: string }> {
  const segment = validateOperation(operation);
  const sourceUrl = await decryptSourceUrl(env.DOWNLOAD_LINK_HMAC_SECRET, operation.source_cipher!);
  if (!sourceUrl) throw fail("The audio source could not be opened.", 400);
  const expiresAt = Date.parse(operation.expires_at);
  const remainingMs = Math.max(1, Math.min(INTEGRATION_AUDIO_TIMEOUT_MS, expiresAt - Date.now()));
  const deadlineAt = Math.min(expiresAt / 1000, (Date.now() + remainingMs) / 1000);
  const body = JSON.stringify({
    accountId: operation.account_id,
    operationId: operation.id,
    sourceUrl,
    segment: { startSeconds: segment.startSeconds, endSeconds: segment.endSeconds },
    expiresAt: operation.expires_at,
  });
  let response: Response;
  try {
    response = await containerFor(env).fetch(new Request("https://downloader.internal/v1/integration/audio/prepare", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.INTERNAL_CONTAINER_SECRET}`,
        "x-digibot-deadline-at": String(deadlineAt),
      },
      body,
      signal: AbortSignal.timeout(remainingMs),
    }));
  } catch (error) {
    if (error instanceof IntegrationFailure) throw error;
    throw fail("The audio extractor is unavailable.", 503, true);
  }
  if (!response.ok || response.headers.get("content-type")?.startsWith("audio/mpeg") !== true) {
    const failure = await readIntegrationJson(response).catch(() => null);
    const retryable = response.status >= 500 || (typeof failure === "object" && failure !== null
      && "status" in failure && failure.status === "failed" && "retryable" in failure && failure.retryable === true);
    throw fail("The audio segment could not be prepared.", retryable ? 503 : 400, retryable);
  }
  const { bytes, metadata } = await readAudioResponse(response);
  const tempKey = `integration/${operation.account_id}/${operation.id}/audio.mp3`;
  const bucket = env.MEDIA_BUCKET;
  if (!bucket) throw fail("Integration temporary storage is unavailable.", 503, true);
  try {
    await bucket.put(tempKey, bytes, {
      httpMetadata: { contentType: "audio/mpeg", cacheControl: "private, no-store" },
      customMetadata: {
        mediaSha256: metadata.mediaSha256,
        audioDurationSeconds: String(metadata.durationSeconds),
        expiresAt: operation.expires_at,
      },
    });
  } catch {
    await bucket.delete(tempKey).catch(() => undefined);
    throw fail("Integration temporary storage is unavailable.", 503, true);
  } finally {
    bytes.fill(0);
  }
  return {
    input: {
      version: 1,
      operationId: operation.id.toLowerCase(),
      action: "check",
      forceRecheck: false,
      media: {
        mediaSha256: metadata.mediaSha256,
        byteLength: metadata.byteLength,
        mimeType: "audio/mpeg",
        inputKind: "derived_audio_segment",
        audioDurationSeconds: metadata.durationSeconds,
        segment,
        fullSourceSha256: null,
      },
    },
    tempKey,
  };
}
