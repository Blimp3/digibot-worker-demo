import { IntegrationFailure } from "./integration-store";

export async function readIntegrationBytes(request: Request | Response, maxBytes: number, timeoutMs = 15_000): Promise<Uint8Array> {
  if (!request.body || Number(request.headers.get("content-length") ?? 0) > maxBytes) throw new IntegrationFailure(413, "input_too_large", "The request exceeds the allowed size.");
  const reader = request.body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => undefined); }, timeoutMs);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (timedOut) throw new IntegrationFailure(408, "request_timeout", "The request timed out.", true);
      if (next.done) break;
      length += next.value.byteLength;
      if (length > maxBytes) throw new IntegrationFailure(413, "input_too_large", "The request exceeds the allowed size.");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  } finally { clearTimeout(timer); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

export async function readIntegrationJson(request: Request | Response, maxBytes = 16 * 1024): Promise<unknown> {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readIntegrationBytes(request, maxBytes))) as unknown; }
  catch (error) { if (error instanceof IntegrationFailure) throw error; throw new IntegrationFailure(400, "invalid_json", "Invalid JSON request."); }
}
