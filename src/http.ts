const DEFAULT_TIMEOUT_MS = 5000;

/**
 * fetch with a hard timeout. Without this, a hung external API (Slack, Google) leaves
 * the whole waitUntil task stuck until Cloudflare force-cancels it at its ~30s ceiling —
 * silently, since nothing ever rejects and our own retry/fallback logic never triggers.
 */
export async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
