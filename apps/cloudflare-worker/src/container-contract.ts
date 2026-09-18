import type { WorkerConfig } from "./config";
import { ApplicationError } from "./errors";
import { sanitizeFilename } from "./security";
import { isValidTrimRange, storedClipRanges } from "./trim";
import type { ContainerDeliveryRequest, ContainerJobRequest, ContainerSuccessResult, JobRecord, TelegramFileSource } from "./types";

export const CONTAINER_DEADLINE_HEADER = "X-DigiBot-Deadline-At";

function validateDeadlineAt(deadlineAt: number): number {
  if (!Number.isSafeInteger(deadlineAt) || deadlineAt <= 0) throw new ApplicationError("INTERNAL_ERROR");
  return deadlineAt;
}

/** Carry the absolute expiry out of the legacy JSON body contract. */
export function buildContainerDeadlineHeaders(deadlineAt?: number): Record<string, string> {
  return deadlineAt === undefined ? {} : { [CONTAINER_DEADLINE_HEADER]: String(validateDeadlineAt(deadlineAt)) };
}

export function buildPrepareRequest(
  job: JobRecord,
  decryptedSource: string,
  config: Pick<WorkerConfig, "defaultMaxHeight">,
  deadlineAt?: number,
): ContainerJobRequest {
  const waitingMessageId = Number(job.waiting_message_id);
  if (!Number.isSafeInteger(waitingMessageId) || waitingMessageId <= 0) throw new ApplicationError("INTERNAL_ERROR");
  const trimStartSeconds = job.requested_start_seconds ?? null;
  const trimEndSeconds = job.requested_end_seconds ?? null;
  if ((trimStartSeconds === null) !== (trimEndSeconds === null)) throw new ApplicationError("INVALID_TIME_RANGE");
  if (trimStartSeconds !== null && trimEndSeconds !== null && !isValidTrimRange(trimStartSeconds, trimEndSeconds)) {
    throw new ApplicationError("INVALID_TIME_RANGE");
  }
  const transcript = job.requested_operation === "transcript";
  const clipRanges = storedClipRanges(job.requested_clip_ranges);
  if (clipRanges && (transcript || job.requested_mode !== "video" || trimStartSeconds !== null || trimEndSeconds !== null)) throw new ApplicationError("INVALID_REQUEST");
  let source: { sourceUrl: string } | { telegramFile: TelegramFileSource };
  if (job.source_kind === "telegram_file") {
    if (transcript || decryptedSource.length > 4096) throw new ApplicationError("INVALID_REQUEST");
    let payload: unknown;
    try { payload = JSON.parse(decryptedSource) as unknown; }
    catch { throw new ApplicationError("INVALID_REQUEST"); }
    source = { telegramFile: validateTelegramFile(payload) };
  } else {
    if (job.source_kind !== undefined && job.source_kind !== "url") throw new ApplicationError("INVALID_REQUEST");
    source = { sourceUrl: decryptedSource };
  }
  const qualityHeights: Readonly<Record<string, number>> = { "max-144p": 144, "max-240p": 240, "max-360p": 360, "max-480p": 480, "max-720p": 720, "max-1080p": 1080 };
  // Legacy jobs without a selection, or using the configured default, keep that ceiling.
  const requestedHeight = job.requested_quality == null || job.requested_quality === `max-${config.defaultMaxHeight}p`
    ? config.defaultMaxHeight : Object.hasOwn(qualityHeights, job.requested_quality) ? qualityHeights[job.requested_quality] : undefined;
  if (job.requested_mode === "video" && requestedHeight === undefined) throw new ApplicationError("INTERNAL_ERROR");
  return {
    jobId: job.id,
    ...source,
    telegramChatId: job.telegram_chat_id,
    waitingMessageId,
    mode: job.requested_mode,
    maximumHeight: Math.min(config.defaultMaxHeight, requestedHeight ?? config.defaultMaxHeight),
    preferredFormat: transcript ? "m4a" : job.requested_mode === "video"
      ? "mp4"
      : job.requested_quality?.toLowerCase() === "mp3" ? "mp3" : "m4a",
    ...(transcript ? { operation: "transcript" as const, ...(deadlineAt ? { deadlineAt } : {}) } : {}),
    ...(transcript && job.transcript_method === "captions" ? {
      transcriptMethod: "captions" as const,
      ...(job.caption_language ? { captionLanguage: job.caption_language } : {}),
    } : {}),
    ...(trimStartSeconds !== null && trimEndSeconds !== null ? { trimStartSeconds, trimEndSeconds } : {}),
    ...(clipRanges ? { clipRanges } : {}),
  };
}

export function buildDeliveryRequest(job: JobRecord, prepared: ContainerSuccessResult, deadlineAt?: number): ContainerDeliveryRequest {
  if (!prepared.objectKey) throw new ApplicationError("DOWNLOAD_FAILED");
  const transcript = job.requested_operation === "transcript";
  const clipRanges = storedClipRanges(job.requested_clip_ranges);
  if (clipRanges && (transcript || job.requested_mode !== "video" || job.requested_start_seconds != null || job.requested_end_seconds != null
    || prepared.delivery !== "telegram" || prepared.clipCount !== clipRanges.length || prepared.mimeType !== "video/mp4"
    || !Number.isSafeInteger(prepared.sizeBytes) || prepared.sizeBytes <= 0 || prepared.sizeBytes > 49_000_000
    || typeof prepared.duration !== "number" || !Number.isFinite(prepared.duration) || prepared.duration <= 0
    || prepared.duration > Math.min(120 * clipRanges.length, 300) + 0.25 * clipRanges.length)) throw new ApplicationError("PROCESSING_FAILED");
  if (!clipRanges && prepared.clipCount !== undefined) throw new ApplicationError("PROCESSING_FAILED");
  if (transcript && prepared.delivery !== "telegram") throw new ApplicationError("PROCESSING_FAILED");
  return {
    jobId: job.id,
    telegramChatId: job.telegram_chat_id,
    objectKey: prepared.objectKey,
    filename: sanitizeFilename(prepared.filename),
    mimeType: prepared.mimeType,
    sizeBytes: prepared.sizeBytes,
    mode: job.requested_mode,
    ...(transcript ? { operation: "transcript" as const, ...(deadlineAt ? { deadlineAt } : {}) } : {}),
    ...(transcript && job.transcript_method === "captions" ? {
      transcriptMethod: "captions" as const,
      ...(job.caption_language ? { captionLanguage: job.caption_language } : {}),
    } : {}),
    deliveryMode: prepared.delivery,
    ...(clipRanges ? { clipRanges } : {}),
  };
}

export const MAX_TELEGRAM_SOURCE_FILE_BYTES = 20_000_000;

/** Shared validation for Telegram metadata at admission and decrypted payloads at prepare. */
export function validateTelegramFile(value: unknown): TelegramFileSource {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ApplicationError("INVALID_REQUEST");
  const file = value as Record<string, unknown>;
  if (Object.keys(file).some((key) => !["fileId", "fileSize", "fileName"].includes(key))) throw new ApplicationError("INVALID_REQUEST");
  if (typeof file.fileSize !== "number" || !Number.isSafeInteger(file.fileSize) || file.fileSize <= 0) {
    throw new ApplicationError("INVALID_REQUEST", { message: "Telegram must provide a valid file size. Send one audio or video file up to 20 MB, or use a public media URL." });
  }
  if (file.fileSize > MAX_TELEGRAM_SOURCE_FILE_BYTES) {
    throw new ApplicationError("SOURCE_SIZE_LIMIT", { message: "Telegram conversion accepts files up to 20 MB. For a larger source, use a public media URL." });
  }
  const fileId = typeof file.fileId === "string" ? file.fileId.trim() : "";
  const fileName = typeof file.fileName === "string" ? file.fileName.trim() : undefined;
  const hasControls = [...fileId, ...(fileName ?? "")].some((character) => character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f);
  if (!fileId || fileId.length > 256 || hasControls
    || (file.fileName !== undefined && (!fileName || fileName.length > 190))) {
    throw new ApplicationError("INVALID_REQUEST", { message: "Telegram file details are invalid. Send the audio or video file again, or use a public media URL." });
  }
  return { fileId, fileSize: file.fileSize, ...(fileName ? { fileName } : {}) };
}
