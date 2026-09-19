import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { claimAlert, claimEvent, nextIncidentId } from "../src/dedupe";

describe("dedupe", () => {
  it("claims an event_id only once", async () => {
    const first = await claimEvent(env.DEDUPE, "Ev123");
    const second = await claimEvent(env.DEDUPE, "Ev123");
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("claims a channel+ts alert only once", async () => {
    const first = await claimAlert(env.DEDUPE, "C1", "111.222");
    const second = await claimAlert(env.DEDUPE, "C1", "111.222");
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("issues sequential per-year incident ids", async () => {
    const now = new Date("2026-05-01T00:00:00Z");
    const a = await nextIncidentId(env.DEDUPE, now);
    const b = await nextIncidentId(env.DEDUPE, now);
    expect(a).not.toBe(b);
    expect(a.startsWith("2026-")).toBe(true);
  });
});
