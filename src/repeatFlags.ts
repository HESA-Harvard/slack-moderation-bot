// Shared across every detector that has a concrete Slack user ID for the
// flagged author: cross-post (patterns/crossPost.ts), the flag-emoji handler
// (handlers/reaction.ts), and Stage 1 moderation scoring
// (patterns/moderationScoring.ts, via handlers/messageEvent.ts). /report is
// deliberately excluded — its "who was involved" field is free text, not a
// user picker (CLAUDE.md is explicit this avoids making the form "an
// accusation machine"), so there's no reliable user ID to count against.
export const FLAG_TYPES = ["cross_post", "member_flag", "moderation_flag"] as const;
export type FlagType = (typeof FLAG_TYPES)[number];

export const FLAG_TYPE_LABELS: Record<FlagType, string> = {
  cross_post: "cross-post",
  member_flag: "member flag",
  moderation_flag: "content flag",
};

export const RECENT_FLAG_WINDOW_SECONDS = 30 * 24 * 60 * 60; // 30 days

interface FlagRecord {
  counts: Record<FlagType, number>;
  windowStartAt: number; // epoch ms
}

export interface RecentFlagSummary {
  total: number;
  counts: Record<FlagType, number>;
}

function emptyCounts(): Record<FlagType, number> {
  return { cross_post: 0, member_flag: 0, moderation_flag: 0 };
}

/**
 * Call once per alert (never per message) to track how often this author has
 * been flagged recently, broken out by type — visible context for a human
 * reviewer, never an automated trigger. Same fixed-window-from-first-flag TTL
 * approach used throughout this app: the 30-day window doesn't reset on each
 * new flag, so it reflects a real recent window, not one continuously
 * extended by a slow trickle.
 */
export async function recordFlag(
  kv: KVNamespace,
  authorId: string,
  type: FlagType,
  now: number = Date.now(),
): Promise<RecentFlagSummary> {
  const key = `flags:${authorId}`;
  const existingRaw = await kv.get(key);
  const existing: FlagRecord | null = existingRaw ? JSON.parse(existingRaw) : null;

  const record: FlagRecord = existing ?? { counts: emptyCounts(), windowStartAt: now };
  record.counts[type] += 1;

  const windowEndsAt = record.windowStartAt + RECENT_FLAG_WINDOW_SECONDS * 1000;
  const remainingTtlSeconds = Math.max(60, Math.ceil((windowEndsAt - now) / 1000));
  await kv.put(key, JSON.stringify(record), { expirationTtl: remainingTtlSeconds });

  const total = FLAG_TYPES.reduce((sum, t) => sum + record.counts[t], 0);
  return { total, counts: record.counts };
}

/** e.g. "4 total (2 cross-posts, 1 member flag, 1 content flag)" */
export function formatFlagSummary(summary: RecentFlagSummary): string {
  const parts = FLAG_TYPES.filter((t) => summary.counts[t] > 0).map((t) => {
    const count = summary.counts[t];
    const label = FLAG_TYPE_LABELS[t];
    return `${count} ${label}${count === 1 ? "" : "s"}`;
  });
  return `${summary.total} total (${parts.join(", ")})`;
}
