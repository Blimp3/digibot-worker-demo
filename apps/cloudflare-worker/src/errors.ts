export const ERROR_CODES = [
  "INVALID_URL",
  "UNSUPPORTED_HOST",
  "UNAUTHORIZED_USER",
  "DUPLICATE_UPDATE",
  "UNSUPPORTED_MEDIA",
  "PLAYLIST_NOT_ALLOWED",
  "LIVE_STREAM_NOT_SUPPORTED",
  "LOGIN_REQUIRED",
  "MEDIA_PRIVATE",
  "MEDIA_UNAVAILABLE",
  "SOURCE_RATE_LIMITED",
  "TRANSCRIPT_RATE_LIMITED",
  "CAPTIONS_UNAVAILABLE",
  "CAPTION_LANGUAGE_UNAVAILABLE",
  "SOURCE_BLOCKED_SERVER",
  "DURATION_LIMIT",
  "INVALID_TIME_RANGE",
  "START_BEYOND_DURATION",
  "SOURCE_SIZE_LIMIT",
  "DOWNLOAD_TIMEOUT",
  "DOWNLOAD_FAILED",
  "DENO_MISSING",
  "EJS_MISSING",
  "FFMPEG_MISSING",
  "FFPROBE_MISSING",
  "PROCESSING_FAILED",
  "TELEGRAM_FILE_TOO_LARGE",
  "TELEGRAM_RATE_LIMITED",
  "TELEGRAM_UPLOAD_FAILED",
  "R2_UPLOAD_FAILED",
  "INVALID_REQUEST",
  "UNAUTHORIZED_REQUEST",
  "INTERNAL_ERROR",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

const USER_MESSAGES: Record<ErrorCode, string> = {
  INVALID_URL: "Send one valid HTTP or HTTPS media URL.",
  UNSUPPORTED_HOST: "That source is not enabled for this private bot.",
  UNAUTHORIZED_USER: "This private bot is not enabled for your Telegram account.",
  DUPLICATE_UPDATE: "This request was already accepted.",
  UNSUPPORTED_MEDIA: "That media type is not supported.",
  PLAYLIST_NOT_ALLOWED: "Send one media item, or use /playlist or /channel for a YouTube-only batch of 1–5 items.",
  LIVE_STREAM_NOT_SUPPORTED: "Live streams are not supported.",
  LOGIN_REQUIRED: "This media requires sign-in. Send a public media link that can be opened without signing in.",
  MEDIA_PRIVATE: "This media is private or is not available to the bot.",
  MEDIA_UNAVAILABLE: "The media is unavailable at the source.",
  SOURCE_RATE_LIMITED: "The source or bot is rate-limited. Try again later.",
  TRANSCRIPT_RATE_LIMITED: "DigiBot is already transcribing another item. Try again later.",
  CAPTIONS_UNAVAILABLE: "No supported source captions are available for this item. Use /transcript URL to request speech transcription.",
  CAPTION_LANGUAGE_UNAVAILABLE: "Source captions are unavailable in that language. Try /captions URL without a language to select an available track.",
  SOURCE_BLOCKED_SERVER: "The source blocked the cloud server. Try again later or send a link from another supported source.",
  DURATION_LIMIT: "That media is longer than the configured limit.",
  INVALID_TIME_RANGE: "That trim range is invalid. Choose a positive range within 24 hours.",
  START_BEYOND_DURATION: "The trim starts after the media ends. Choose an earlier start time.",
  SOURCE_SIZE_LIMIT: "That source file is larger than the configured limit.",
  DOWNLOAD_TIMEOUT: "The download took too long. Try a shorter media item.",
  DOWNLOAD_FAILED: "The media could not be downloaded.",
  DENO_MISSING: "The downloader runtime is unavailable on the server.",
  EJS_MISSING: "The downloader JavaScript support is unavailable on the server.",
  FFMPEG_MISSING: "The media processor is unavailable on the server.",
  FFPROBE_MISSING: "The media validator is unavailable on the server.",
  PROCESSING_FAILED: "The media was downloaded but could not be processed.",
  TELEGRAM_FILE_TOO_LARGE: "The processed file is too large for direct Telegram delivery. A temporary download link will be created.",
  TELEGRAM_RATE_LIMITED: "Telegram is rate-limiting the bot. Try again later.",
  TELEGRAM_UPLOAD_FAILED: "Telegram did not accept the processed media.",
  R2_UPLOAD_FAILED: "The temporary download could not be created.",
  INVALID_REQUEST: "The request was not valid.",
  UNAUTHORIZED_REQUEST: "The internal request was not authorized.",
  INTERNAL_ERROR: "The bot could not finish this request. Try again later.",
};

export class ApplicationError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly status: number;

  constructor(code: ErrorCode, options?: { message?: string; retryable?: boolean; status?: number; cause?: unknown }) {
    super(options?.message ?? USER_MESSAGES[code]);
    this.name = "ApplicationError";
    this.code = code;
    this.retryable = options?.retryable ?? false;
    this.status = options?.status ?? 500;
    if (options && "cause" in options) {
      Object.defineProperty(this, "cause", { value: options.cause, enumerable: false });
    }
  }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value);
}

export function safeMessageForError(code: ErrorCode): string {
  return USER_MESSAGES[code];
}

export function mapUnknownError(error: unknown): ApplicationError {
  if (error instanceof ApplicationError) return error;
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; retryable?: unknown; status?: unknown };
    if (isErrorCode(candidate.code)) {
      return new ApplicationError(candidate.code, {
        retryable: candidate.retryable === true,
        status: typeof candidate.status === "number" ? candidate.status : undefined,
        cause: error,
      });
    }
  }
  return new ApplicationError("INTERNAL_ERROR", { cause: error });
}

export function errorCodeFromContainerResult(value: string): ErrorCode {
  if (isErrorCode(value)) return value;
  if (value === "SOURCE_NETWORK_BLOCKED") return "SOURCE_BLOCKED_SERVER";
  if (value === "TELEGRAM_AUTH_FAILED") return "TELEGRAM_UPLOAD_FAILED";
  if (value === "PROCESS_TIMEOUT") return "PROCESSING_FAILED";
  return "DOWNLOAD_FAILED";
}
