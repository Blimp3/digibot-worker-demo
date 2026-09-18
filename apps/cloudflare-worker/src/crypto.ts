import { base64UrlToBytes, bytesToBase64Url } from "./security";

const encoder = new TextEncoder();

async function aesKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

/** Encrypt the source URL before it is persisted in D1. */
export async function encryptSourceUrl(secret: string, sourceUrl: string): Promise<string> {
  if (!secret) throw new Error("missing encryption secret");
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(secret), encoder.encode(sourceUrl)));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(ciphertext)}`;
}

export async function decryptSourceUrl(secret: string, value: string): Promise<string | null> {
  const [version, encodedIv, encodedCiphertext] = value.split(".");
  if (version !== "v1" || !encodedIv || !encodedCiphertext) return null;
  const iv = base64UrlToBytes(encodedIv);
  const ciphertext = base64UrlToBytes(encodedCiphertext);
  if (!iv || !ciphertext || iv.length !== 12) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: iv as unknown as BufferSource },
      await aesKey(secret),
      ciphertext as unknown as BufferSource,
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/**
 * Produce a stable, non-reversible lookup digest for sensitive values.
 * Keying prevents an offline dictionary of common public URLs from being
 * matched against a leaked D1 source_url_hash column.
 */
export async function hmacSha256Hex(secret: string, value: string): Promise<string> {
  if (!secret) throw new Error("missing digest secret");
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = new Uint8Array(await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`private-media-downloader:source-url:v1\0${value}`),
  ));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
