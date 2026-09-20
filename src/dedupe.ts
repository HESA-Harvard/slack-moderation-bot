const EVENT_TTL_SECONDS = 10 * 60;

/** Returns true if this is the first time we've seen event_id (and records it). */
export async function claimEvent(kv: KVNamespace, eventId: string): Promise<boolean> {
  const key = `event:${eventId}`;
  const existing = await kv.get(key);
  if (existing) return false;
  await kv.put(key, "1", { expirationTtl: EVENT_TTL_SECONDS });
  return true;
}

/** Returns true if this is the first alert for this channel+message timestamp. */
export async function claimAlert(kv: KVNamespace, channel: string, messageTs: string): Promise<boolean> {
  const key = `alert:${channel}:${messageTs}`;
  const existing = await kv.get(key);
  if (existing) return false;
  // Alerts should stay deduped for the life of the message, not just a short window.
  await kv.put(key, "1", { expirationTtl: 60 * 60 * 24 * 30 });
  return true;
}

/** Sequential per-year incident id, e.g. "2026-0042". Best-effort under concurrency. */
export async function nextIncidentId(kv: KVNamespace, now: Date = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const key = `counter:${year}`;
  const current = Number((await kv.get(key)) ?? "0");
  const next = current + 1;
  await kv.put(key, String(next));
  return `${year}-${String(next).padStart(4, "0")}`;
}

/**
 * Sequential per-year access-approval id, e.g. "ACCESS-2026-0001" — a
 * separate counter from nextIncidentId so approval records (membership
 * roster) and moderation incidents never share numbering. Same best-effort
 * concurrency tradeoff as nextIncidentId.
 */
export async function nextApprovalId(kv: KVNamespace, now: Date = new Date()): Promise<string> {
  const year = now.getUTCFullYear();
  const key = `access-counter:${year}`;
  const current = Number((await kv.get(key)) ?? "0");
  const next = current + 1;
  await kv.put(key, String(next));
  return `ACCESS-${year}-${String(next).padStart(4, "0")}`;
}
