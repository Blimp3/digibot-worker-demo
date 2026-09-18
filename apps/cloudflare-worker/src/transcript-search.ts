import { TelegramClient } from "./telegram";

const MAX_BYTES = 2_000_000;
const INVALID = "Reply to a DigiBot transcript .md file (up to 2 MB, up to 15 minutes).";
const SILENCE_METHOD = "Digital silence check (Whisper skipped)";
const METHODS = new Set(["Automatic speech transcription (Whisper small)", "Publisher-provided captions", "Automatic captions", SILENCE_METHOD]);
export class TranscriptSearchError extends Error {}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function invalid(): never { throw new TranscriptSearchError(INVALID); }
function normalize(value: string): string { return value.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim(); }
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}]/u;
export function validateTranscriptQuery(query: string): string {
  if (typeof query !== "string" || [...query].length > 200 || UNSAFE.test(query.replace(/[\t\r\n]/gu, ""))) {
    throw new TranscriptSearchError("Use /search followed by a phrase of 1–200 characters.");
  }
  const normalized = normalize(query);
  if (!normalized || [...normalized].length > 200) throw new TranscriptSearchError("Use /search followed by a phrase of 1–200 characters.");
  return normalized;
}
export function validateTranscriptDocument(value: unknown): { file_id: string; file_size: number } {
  const doc = record(value);
  if (typeof doc.file_id !== "string" || !/^[A-Za-z0-9_-]{1,512}$/u.test(doc.file_id)
    || typeof doc.file_name !== "string" || doc.file_name.length > 255 || !/^[^/\\:\p{Cc}\p{Cf}\p{Cs}]+\.md$/iu.test(doc.file_name)
    || typeof doc.file_size !== "number" || !Number.isSafeInteger(doc.file_size) || doc.file_size < 1 || doc.file_size > MAX_BYTES) invalid();
  return { file_id: doc.file_id, file_size: doc.file_size };
}
interface Segment { timestamp: string; text: string }
export interface Transcript { title: string; method: string; language?: string; segments: Segment[] }
function timestamp(value: string): number {
  if (!/^\d{2}:[0-5]\d:[0-5]\d\.\d{3}$/u.test(value)) invalid();
  const [hours, minutes, seconds] = value.split(":").map(Number);
  return hours! * 3600 + minutes! * 60 + seconds!;
}
export function parseTranscriptMarkdown(text: string): Transcript {
  if (new TextEncoder().encode(text).length > MAX_BYTES || /[\p{Cc}\p{Cs}]/u.test(text.replace(/[\r\n\t]/gu, ""))) invalid();
  const lines = text.replace(/\r\n/gu, "\n").split("\n");
  if (lines.length > 20_020) invalid();
  const heading = lines.indexOf("## Transcript");
  if (heading < 1 || heading > 12 || !/^# .{1,500}$/u.test(lines[0]!)) invalid();
  const metadata: Record<string, string> = {};
  for (const line of lines.slice(1, heading).filter(line => line.trim())) {
    const match = /^(Source|Duration|Method|Language): (.+)$/u.exec(line);
    if (!match || metadata[match[1]!] !== undefined) invalid();
    metadata[match[1]!] = match[2]!;
  }
  const duration = timestamp(metadata.Duration ?? "");
  if (!metadata.Source || metadata.Source.length > 2000 || duration <= 0 || duration > 900 || !METHODS.has(metadata.Method ?? "")
    || (metadata.Language !== undefined && !/^[\p{L}\p{N} _().-]{1,80}$/u.test(metadata.Language))) invalid();
  const body = lines.slice(heading + 1).join("\n").trim();
  const result: Transcript = { title: lines[0]!.slice(2), method: metadata.Method!, language: metadata.Language, segments: [] };
  if (body === "_(No speech was detected.)_") return result;
  if (metadata.Method === SILENCE_METHOD) invalid();
  if (!body) invalid();
  let previous = -1;
  for (const paragraph of body.split(/\n[\t ]*\n/gu)) {
    const match = /^\[(\d{2}:\d{2}:\d{2}\.\d{3})\] ([^\n]+)$/u.exec(paragraph);
    if (!match || !match[2]!.trim()) invalid();
    const seconds = timestamp(match[1]!);
    if (seconds < previous || seconds > duration + 0.5) invalid();
    previous = seconds;
    result.segments.push({ timestamp: match[1]!, text: match[2]! });
    if (result.segments.length > 10_000) invalid();
  }
  return result;
}
function clip(value: string, limit: number): string {
  if (value.length <= limit) return value;
  return value.slice(0, limit - 1).replace(/[\uD800-\uDBFF]$/u, "") + "…";
}
function excerpt(text: string, needle: string): string {
  const match = normalize(text).indexOf(needle);
  if (text.length <= 700 || match < 0) return clip(text, 700);
  // Locate the original display offset without replacing its Unicode spelling.
  let low = 0, high = text.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (normalize(text.slice(0, middle)).length < match) low = middle + 1;
    else high = middle;
  }
  let start = Math.max(0, low - 100);
  if (/[\uDC00-\uDFFF]/u.test(text[start] ?? "")) start++;
  return (start ? "…" : "") + clip(text.slice(start), 699);
}
export function searchTranscript(transcript: Transcript, query: string): string {
  const needle = validateTranscriptQuery(query);
  const matches = transcript.segments.flatMap((segment, index) => normalize(segment.text).includes(needle) ? [index] : []);
  const header = `${clip(transcript.title, 160)}\nMethod (file metadata): ${transcript.method}${transcript.language ? `\nLanguage: ${transcript.language}` : ""}`;
  if (!matches.length) return `${header}\n\nNo matches found.`;
  const ranges: [number, number][] = [];
  for (const index of matches) {
    const start = Math.max(0, index - 1), end = Math.min(transcript.segments.length - 1, index + 1);
    const last = ranges.at(-1);
    if (last && start <= last[1] + 1) last[1] = end;
    else ranges.push([start, end]);
  }
  let output = `${header}\n\n${matches.length} matching passage${matches.length === 1 ? "" : "s"}:`;
  let truncated = false;
  outer: for (const [start, end] of ranges) {
    for (let index = start; index <= end; index++) {
      const segment = transcript.segments[index]!;
      const display = excerpt(segment.text, needle);
      const line = `${index === start ? "\n\n" : "\n"}[${segment.timestamp}] ${display}`;
      if (output.length + line.length > 3400) { truncated = true; break outer; }
      truncated ||= display !== segment.text;
      output += line;
    }
  }
  return output + (truncated ? "\n\nResults truncated; use a more specific phrase." : "");
}

async function download(url: string, fetcher: typeof fetch): Promise<string> {
  const controller = new AbortController();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  const timeout = setTimeout(() => controller.abort(), 8_000);
  const deadline = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("deadline")), { once: true }));
  try {
    const pending = fetcher(url, { redirect: "manual", signal: controller.signal });
    void pending.then(late => { if (controller.signal.aborted) void late.body?.cancel().catch(() => undefined); }, () => undefined);
    response = await Promise.race([pending, deadline]);
    if (!response.ok || response.redirected || (response.url && response.url !== url)) invalid();
    const length = response.headers.get("content-length");
    if (length !== null && (!/^\d+$/u.test(length) || Number(length) > MAX_BYTES)) invalid();
    if (!response.body) invalid();
    reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let bytes = 0, text = "";
    while (true) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_BYTES) invalid();
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    clearTimeout(timeout);
    if (reader) { void reader.cancel().catch(() => undefined); reader.releaseLock(); }
    else if (response) void response.body?.cancel().catch(() => undefined);
  }
}
export async function searchTranscriptDocument(botToken: string, document: unknown, query: string, fetcher: typeof fetch = fetch): Promise<string> {
  validateTranscriptQuery(query);
  const doc = validateTranscriptDocument(document);
  try {
    if (!/^\d+:[A-Za-z0-9_-]+$/u.test(botToken)) invalid();
    const file = record(await new TelegramClient({ token: botToken, fetchImpl: fetcher, requestTimeoutMs: 7_000 }).getFile(doc.file_id));
    if (file.file_id !== doc.file_id || typeof file.file_size !== "number" || !Number.isSafeInteger(file.file_size)
      || file.file_size < 1 || file.file_size > MAX_BYTES || typeof file.file_path !== "string"
      || file.file_path.length > 512 || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?$/u.test(file.file_path)) invalid();
    const text = await download(`https://api.telegram.org/file/bot${botToken}/${file.file_path}`, fetcher);
    return searchTranscript(parseTranscriptMarkdown(text), query);
  } catch (error) {
    if (error instanceof TranscriptSearchError) throw error;
    throw new TranscriptSearchError("Could not read that transcript. Please attach the .md file again and retry.");
  }
}
