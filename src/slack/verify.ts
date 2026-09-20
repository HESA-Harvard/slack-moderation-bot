const MAX_TIMESTAMP_SKEW_SECONDS = 5 * 60;

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifies a Slack request per https://api.slack.com/authentication/verifying-requests-from-slack.
 * Must be called with the raw, unparsed request body — signing covers exact bytes.
 */
export async function verifySlackSignature(
  signingSecret: string,
  timestampHeader: string | null,
  signatureHeader: string | null,
  rawBody: string,
): Promise<boolean> {
  if (!timestampHeader || !signatureHeader) return false;

  const timestamp = Number(timestampHeader);
  if (!Number.isFinite(timestamp)) return false;

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestamp) > MAX_TIMESTAMP_SKEW_SECONDS) return false;

  const base = `v0:${timestampHeader}:${rawBody}`;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(base));
  const computed = `v0=${toHex(mac)}`;

  return timingSafeEqual(computed, signatureHeader);
}
