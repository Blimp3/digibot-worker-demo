import type { Env } from "./types";

export const DEFAULT_SOURCE_HOSTS = [
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "youtu.be",
  "instagram.com",
  "www.instagram.com",
  "tiktok.com",
  "www.tiktok.com",
  "vm.tiktok.com",
  "vt.tiktok.com",
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "vimeo.com",
  "www.vimeo.com",
  "player.vimeo.com",
  "reddit.com",
  "www.reddit.com",
  "old.reddit.com",
  "np.reddit.com",
  "nm.reddit.com",
  "redditmedia.com",
  "www.redditmedia.com",
  "pinterest.com",
  "www.pinterest.com",
  "pinterest.ca",
  "www.pinterest.ca",
  "co.pinterest.com",
  "www.ted.com",
  "embed.ted.com",
  "embed-ssl.ted.com",
] as const;

function positiveInt(value: string | undefined, fallback: number, max = Number.MAX_SAFE_INTEGER): number {
  if (!value || !/^\d+$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= max ? parsed : fallback;
}

export interface WorkerConfig {
  allowedSourceHosts: Set<string>;
  maxUrlLength: number;
  maxMediaDurationSeconds: number;
  maxSourceBytes: number;
  maxTelegramBytes: number;
  maxJobsPerHour: number;
  maxActiveJobs: number;
  maxActiveTranscriptions: number;
  defaultMaxHeight: number;
  jobTimeoutSeconds: number;
  transcriptionTimeoutSeconds: number;
  maxTranscriptDurationSeconds: number;
  r2LinkTtlSeconds: number;
  r2RetentionSeconds: number;
  publicWorkerBaseUrl: string;
  telegramApiBase: string;
}

export function getWorkerConfig(env: Pick<Env, keyof Env>): WorkerConfig {
  const configuredHosts = env.ALLOWED_SOURCE_HOSTS
    ?.split(/[\s,]+/u)
    .map((host) => {
      const candidate = host.trim().toLowerCase();
      try {
        return new URL(`http://${candidate}`).hostname.toLowerCase().replace(/\.$/u, "");
      } catch {
        return candidate.replace(/\.$/u, "");
      }
    })
    .filter(Boolean);
  const allowedSourceHosts = new Set(configuredHosts?.length ? configuredHosts : DEFAULT_SOURCE_HOSTS);
  const telegramApiBase = env.TELEGRAM_BOT_API_BASE?.trim() || "https://api.telegram.org";

  return {
    allowedSourceHosts,
    maxUrlLength: positiveInt(env.MAX_URL_LENGTH, 2048, 8192),
    maxMediaDurationSeconds: positiveInt(env.MAX_MEDIA_DURATION_SECONDS, 7200, 86400),
    maxSourceBytes: positiveInt(env.MAX_SOURCE_BYTES, 500 * 1024 * 1024),
    maxTelegramBytes: positiveInt(env.MAX_TELEGRAM_BYTES, 49_000_000),
    maxJobsPerHour: positiveInt(env.MAX_JOBS_PER_HOUR, 5, 1000),
    maxActiveJobs: positiveInt(env.MAX_ACTIVE_JOBS, 1, 100),
    maxActiveTranscriptions: positiveInt(env.MAX_ACTIVE_TRANSCRIPTIONS, 1, 100),
    defaultMaxHeight: positiveInt(env.DEFAULT_MAX_HEIGHT, 1080, 4320),
    jobTimeoutSeconds: positiveInt(env.JOB_TIMEOUT_SECONDS, 1200, 86400) || 1200,
    transcriptionTimeoutSeconds: positiveInt(env.TRANSCRIPTION_TIMEOUT_SECONDS, 1800, 1800) || 1800,
    maxTranscriptDurationSeconds: positiveInt(env.MAX_TRANSCRIPT_DURATION_SECONDS, 900, 900) || 900,
    r2LinkTtlSeconds: positiveInt(env.R2_LINK_TTL_SECONDS, 3600, 7 * 86400),
    r2RetentionSeconds: positiveInt(env.R2_RETENTION_SECONDS, 86400, 30 * 86400),
    publicWorkerBaseUrl: env.PUBLIC_WORKER_BASE_URL?.trim() || "",
    telegramApiBase,
  };
}
