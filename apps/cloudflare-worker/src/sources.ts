import type { JobOperation, MediaMode, TranscriptMethod } from "./types";
import { formatTrimRequest, type TrimRange } from "./trim";
import type { ValidatedSourceUrl } from "./url";

/** Stable states shared by Telegram today and a future Supported Sources UI. */
export const SOURCE_STATES = [
  "verified",
  "recognized_unverified",
  "intentionally_unsupported",
] as const;

export type SourceState = (typeof SOURCE_STATES)[number];

export interface SourceCatalogEntry {
  readonly id: string;
  readonly displayName: string;
  readonly hosts: readonly string[];
  readonly state: SourceState;
  readonly coverage: string;
  readonly note: string;
}

/**
 * The provider catalog is deliberately conservative. A provider is not
 * marked verified merely because yt-dlp recognizes its hostname; verification
 * means a real DigiBot end-to-end delivery has already been observed.
 */
export const SOURCE_CATALOG = Object.freeze([
  Object.freeze({
    id: "youtube",
    displayName: "YouTube",
    hosts: Object.freeze(["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"]),
    state: "verified",
    coverage: "Public videos",
    note: "Verified end to end in DigiBot for public videos.",
  }),
  Object.freeze({
    id: "youtube-music",
    displayName: "YouTube Music",
    hosts: Object.freeze(["music.youtube.com"]),
    state: "recognized_unverified",
    coverage: "Public tracks as M4A audio",
    note: "Track links select audio automatically. Use /playlist URL 3 m4a for a bounded YouTube playlist; no automatic album download. Provider availability varies.",
  }),
  Object.freeze({
    id: "instagram",
    displayName: "Instagram",
    hosts: Object.freeze(["instagram.com", "www.instagram.com"]),
    state: "verified",
    coverage: "Public Reels",
    note: "Verified end to end in DigiBot for public Reels.",
  }),
  Object.freeze({
    id: "tiktok",
    displayName: "TikTok",
    hosts: Object.freeze(["tiktok.com", "www.tiktok.com", "vm.tiktok.com", "vt.tiktok.com"]),
    state: "recognized_unverified",
    coverage: "Engine-recognized public links",
    note: "Recognized by the download engine; DigiBot delivery is not yet end-to-end verified.",
  }),
  Object.freeze({
    id: "x-twitter",
    displayName: "X/Twitter",
    hosts: Object.freeze(["x.com", "www.x.com", "twitter.com", "www.twitter.com"]),
    state: "recognized_unverified",
    coverage: "Engine-recognized public links",
    note: "Recognized by the download engine; DigiBot delivery is not yet end-to-end verified.",
  }),
  Object.freeze({
    id: "vimeo",
    displayName: "Vimeo",
    hosts: Object.freeze(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]),
    state: "recognized_unverified",
    coverage: "Engine-recognized public links",
    note: "Recognized by the download engine; DigiBot delivery is not yet end-to-end verified.",
  }),
  Object.freeze({
    id: "reddit",
    displayName: "Reddit",
    hosts: Object.freeze([
      "reddit.com",
      "www.reddit.com",
      "old.reddit.com",
      "np.reddit.com",
      "nm.reddit.com",
      "redditmedia.com",
      "www.redditmedia.com",
    ]),
    state: "recognized_unverified",
    coverage: "Engine-recognized public links",
    note: "Recognized by the download engine; DigiBot delivery is not yet end-to-end verified.",
  }),
  Object.freeze({
    id: "pinterest",
    displayName: "Pinterest",
    hosts: Object.freeze(["pinterest.com", "www.pinterest.com", "pinterest.ca", "www.pinterest.ca", "co.pinterest.com"]),
    state: "recognized_unverified",
    coverage: "Engine-recognized public links",
    note: "Recognized by the download engine; DigiBot delivery is not yet end-to-end verified.",
  }),
  Object.freeze({
    id: "ted",
    displayName: "TED",
    hosts: Object.freeze(["www.ted.com", "embed.ted.com", "embed-ssl.ted.com"]),
    state: "recognized_unverified",
    coverage: "Engine-recognized public links",
    note: "Recognized by the download engine; DigiBot delivery is not yet end-to-end verified.",
  }),
  Object.freeze({
    id: "protected-content",
    displayName: "Protected or unauthorized content",
    hosts: Object.freeze([]),
    state: "intentionally_unsupported",
    coverage: "Private, login-gated, age-gated, DRM, CAPTCHA, paywalled, or unauthorized media",
    note: "The bot does not bypass access controls or retrieve media without authorization.",
  }),
] as const satisfies readonly SourceCatalogEntry[]);

const SOURCE_STATE_LABELS: Readonly<Record<SourceState, string>> = {
  verified: "Verified end to end in DigiBot",
  recognized_unverified: "Recognized/available through the engine but not yet verified",
  intentionally_unsupported: "Intentionally unsupported",
};

/**
 * Match only exact normalized hostnames. Callers must invoke this with the
 * result of validateSourceUrl(), after the existing allowlist and SSRF checks.
 */
export function sourceForValidatedUrl(source: Pick<ValidatedSourceUrl, "hostname">): SourceCatalogEntry | null {
  const hostname = source.hostname.trim().toLowerCase().replace(/\.$/u, "");
  return SOURCE_CATALOG.find((entry) => entry.hosts.some((host) => host === hostname)) ?? null;
}

export function formatSourceCatalog(): string {
  const lines = ["Supported sources", ""];
  for (const state of SOURCE_STATES) {
    lines.push(`${SOURCE_STATE_LABELS[state]}:`);
    const entries = SOURCE_CATALOG.filter((entry) => entry.state === state);
    for (const entry of entries) lines.push(`• ${entry.displayName} — ${entry.coverage}. ${entry.note}`);
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function initialPreparationMessage(
  source: SourceCatalogEntry | null,
  mode: MediaMode,
  trim: TrimRange | null = null,
  operation: JobOperation = "download",
  transcriptMethod: TranscriptMethod = "whisper",
): string {
  const displayName = source?.displayName ?? "Configured source";
  const status = source?.state === "recognized_unverified"
    ? "recognized; delivery not yet verified"
    : source?.state === "verified"
      ? `verified for ${source.coverage.toLowerCase()}`
      : "configured";
  const trimText = trim ? `\nTrim: ${formatTrimRequest(trim)}.` : "";
  const action = operation === "transcript" ? transcriptMethod === "captions" ? "source captions" : "timestamped transcript" : mode;
  return `Accepted — preparing ${action}…\nSource: ${displayName} (${status})${trimText}`;
}
