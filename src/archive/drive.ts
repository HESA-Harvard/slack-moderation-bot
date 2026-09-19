import type { IncidentRecord } from "./schema";
import { postFailureNotice } from "../slack/api";
import { fetchWithTimeout } from "../http";

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
// supportsAllDrives is required or the API 404s on any file/folder living in a Shared Drive.
const DRIVE_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true";
const SCOPE = "https://www.googleapis.com/auth/drive.file";
const TOKEN_CACHE_KEY = "google:access_token";
const TOKEN_REFRESH_SKEW_SECONDS = 60;

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function base64UrlEncode(input: ArrayBuffer | string): string {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : new Uint8Array(input);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const stripped = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, "")
    .replace(/-----END PRIVATE KEY-----/, "")
    .replace(/\s/g, "");
  const binary = atob(stripped);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function mintAccessToken(saKeyJson: string): Promise<{ token: string; expiresInSeconds: number }> {
  const sa = JSON.parse(saKeyJson) as ServiceAccountKey;
  const nowSeconds = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  };

  const unsigned = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(claims))}`;

  const key = await crypto.subtle.importKey(
    "pkcs8",
    pemToArrayBuffer(sa.private_key),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(unsigned));
  const jwt = `${unsigned}.${base64UrlEncode(signature)}`;

  const res = await fetchWithTimeout(
    TOKEN_ENDPOINT,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: jwt,
      }),
    },
    DRIVE_FETCH_TIMEOUT_MS,
  );

  if (!res.ok) {
    throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  return { token: body.access_token, expiresInSeconds: body.expires_in };
}

async function getAccessToken(kv: KVNamespace, saKeyJson: string): Promise<string> {
  const cached = await kv.get(TOKEN_CACHE_KEY);
  if (cached) return cached;

  const { token, expiresInSeconds } = await mintAccessToken(saKeyJson);
  await kv.put(TOKEN_CACHE_KEY, token, {
    expirationTtl: Math.max(60, expiresInSeconds - TOKEN_REFRESH_SKEW_SECONDS),
  });
  return token;
}

/** Filesystem-safe rendering of an ISO timestamp, e.g. "2026-09-19T14-22-03Z" — still sorts chronologically. */
function filenameTimestamp(isoTimestamp: string): string {
  return isoTimestamp.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
}

function multipartBody(record: IncidentRecord, folderId: string): { body: string; boundary: string } {
  const boundary = `hesa-${crypto.randomUUID()}`;
  const metadata = JSON.stringify({
    name: `${record.incident_id}_${filenameTimestamp(record.captured_at)}.json`,
    parents: [folderId],
    mimeType: "application/json",
  });
  const body =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json\r\n\r\n${JSON.stringify(record, null, 2)}\r\n` +
    `--${boundary}--`;
  return { body, boundary };
}

/** Returns the created file's id. */
async function uploadOnce(record: IncidentRecord, folderId: string, token: string): Promise<string> {
  const { body, boundary } = multipartBody(record, folderId);
  const res = await fetchWithTimeout(
    DRIVE_UPLOAD_ENDPOINT,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    },
    DRIVE_FETCH_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(`Drive upload failed: ${res.status} ${await res.text()}`);
  }
  const created = (await res.json()) as { id: string };
  return created.id;
}

const DRIVE_FETCH_TIMEOUT_MS = 3000;
// Kept short: Cloudflare force-cancels waitUntil() work at ~30s with no error and no
// fallback triggered, so total retry time (delays + per-attempt timeouts) must leave
// headroom for the alert/ephemeral posts that follow a failed archive write.
const RETRY_DELAYS_MS = [300, 1000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ArchiveEnv {
  DEDUPE: KVNamespace;
  GOOGLE_SA_KEY: string;
  ARCHIVE_FOLDER_ID: string;
  SLACK_BOT_TOKEN: string;
  MOD_ALERTS_CHANNEL: string;
}

/**
 * Writes the incident record to the archive and returns a link to the created file.
 * Never throws: on total failure it posts a loud, record-containing notice into
 * #mod-alerts instead of losing the evidence silently — see CLAUDE.md Section 8 —
 * and returns undefined, since there's no file to link to.
 */
export async function writeArchiveRecord(env: ArchiveEnv, record: IncidentRecord): Promise<string | undefined> {
  for (const delay of [0, ...RETRY_DELAYS_MS]) {
    if (delay > 0) await sleep(delay);
    try {
      const token = await getAccessToken(env.DEDUPE, env.GOOGLE_SA_KEY);
      const fileId = await uploadOnce(record, env.ARCHIVE_FOLDER_ID, token);
      return `https://drive.google.com/file/d/${fileId}/view`;
    } catch (err) {
      console.error("archive write attempt failed", err);
    }
  }

  console.error(`ARCHIVE WRITE FAILED PERMANENTLY for incident ${record.incident_id}`);
  try {
    await postFailureNotice(env.SLACK_BOT_TOKEN, env.MOD_ALERTS_CHANNEL, record);
  } catch (err) {
    // Last resort: if even the failure notice can't be posted (e.g. the bot isn't in
    // #mod-alerts), the full record must still land somewhere a human can find it.
    console.error(`FAILURE NOTICE ALSO FAILED for incident ${record.incident_id}`, err, JSON.stringify(record));
  }
  return undefined;
}
