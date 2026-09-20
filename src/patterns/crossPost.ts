import { toHex } from "../crypto";

// Starting points for shadow-mode calibration — not tuned against real
// traffic yet. See README "Cross-post detection (shadow mode)".
export const CROSS_POST_CHANNEL_THRESHOLD = 3;
export const CROSS_POST_WINDOW_SECONDS = 10 * 60;
export const MIN_MESSAGE_LENGTH = 10;
export const RECENT_FLAG_WINDOW_SECONDS = 30 * 24 * 60 * 60; // 30 days

export interface CrossPostOccurrence {
  channel: string;
  ts: string;
}

interface CrossPostRecord {
  occurrences: CrossPostOccurrence[];
  firstSeenAt: number; // epoch ms
  alerted: boolean;
}

function keyFor(authorId: string, hash: string): string {
  return `crosspost:${authorId}:${hash}`;
}

/** Lowercased, whitespace-collapsed SHA-256 of the message text — never the text itself is stored. */
export async function hashMessageText(text: string): Promise<string> {
  const normalized = text.toLowerCase().trim().replace(/\s+/g, " ");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalized));
  return toHex(digest);
}

/**
 * Records one occurrence of a (author, message-hash) pair and reports whether
 * this crossing just tripped the distinct-channel threshold for the first
 * time. The window is fixed from the first occurrence, not renewed on each
 * new one — a burst has to happen within one real window, not get extended
 * indefinitely by a slow trickle of the same message over hours.
 */
export async function recordCrossPost(
  kv: KVNamespace,
  authorId: string,
  hash: string,
  channel: string,
  ts: string,
  now: number = Date.now(),
): Promise<{ shouldAlert: boolean; occurrences: CrossPostOccurrence[] }> {
  const key = keyFor(authorId, hash);
  const existingRaw = await kv.get(key);
  const existing: CrossPostRecord | null = existingRaw ? JSON.parse(existingRaw) : null;

  const record: CrossPostRecord = existing ?? { occurrences: [], firstSeenAt: now, alerted: false };
  if (!record.occurrences.some((o) => o.channel === channel)) {
    record.occurrences.push({ channel, ts });
  }

  const windowEndsAt = record.firstSeenAt + CROSS_POST_WINDOW_SECONDS * 1000;
  const remainingTtlSeconds = Math.max(60, Math.ceil((windowEndsAt - now) / 1000));

  const justCrossed = !record.alerted && record.occurrences.length >= CROSS_POST_CHANNEL_THRESHOLD;
  if (justCrossed) record.alerted = true;

  await kv.put(key, JSON.stringify(record), { expirationTtl: remainingTtlSeconds });

  return { shouldAlert: justCrossed, occurrences: record.occurrences };
}

interface RepeatFlagRecord {
  count: number;
  windowStartAt: number; // epoch ms
}

/**
 * Call once per cross-post *alert* (not per message) to track how often this
 * author has been flagged recently — context for a human reviewer, never an
 * automated trigger. Returns the new count. Separate, much longer window
 * than the burst-detection one above: this is "how often does this keep
 * happening," not "is this one burst a cross-post."
 */
export async function recordRepeatFlag(kv: KVNamespace, authorId: string, now: number = Date.now()): Promise<number> {
  const key = `crosspost-flags:${authorId}`;
  const existingRaw = await kv.get(key);
  const existing: RepeatFlagRecord | null = existingRaw ? JSON.parse(existingRaw) : null;

  const record: RepeatFlagRecord = existing ?? { count: 0, windowStartAt: now };
  record.count += 1;

  const windowEndsAt = record.windowStartAt + RECENT_FLAG_WINDOW_SECONDS * 1000;
  const remainingTtlSeconds = Math.max(60, Math.ceil((windowEndsAt - now) / 1000));
  await kv.put(key, JSON.stringify(record), { expirationTtl: remainingTtlSeconds });

  return record.count;
}
