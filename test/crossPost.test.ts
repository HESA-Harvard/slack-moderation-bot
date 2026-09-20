import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { hashMessageText, recordCrossPost, recordRepeatFlag, CROSS_POST_CHANNEL_THRESHOLD } from "../src/patterns/crossPost";

describe("hashMessageText", () => {
  it("normalizes case and whitespace so equivalent text hashes the same", async () => {
    const a = await hashMessageText("Check out my  awesome   startup!");
    const b = await hashMessageText("  check out my awesome startup!  ");
    expect(a).toBe(b);
  });

  it("hashes different text differently", async () => {
    const a = await hashMessageText("Check out my startup");
    const b = await hashMessageText("Check out my other startup");
    expect(a).not.toBe(b);
  });
});

describe("recordCrossPost", () => {
  it("does not alert until the channel threshold is crossed", async () => {
    const hash = await hashMessageText("spam message one");
    const first = await recordCrossPost(env.DEDUPE, "U_SPAMMER1", hash, "C1", "1.1");
    expect(first.shouldAlert).toBe(false);

    const second = await recordCrossPost(env.DEDUPE, "U_SPAMMER1", hash, "C2", "1.2");
    expect(second.shouldAlert).toBe(false);
    expect(CROSS_POST_CHANNEL_THRESHOLD).toBe(3); // sanity check the test matches the real threshold
  });

  it("alerts exactly once, the moment the threshold is crossed", async () => {
    const hash = await hashMessageText("spam message two");
    await recordCrossPost(env.DEDUPE, "U_SPAMMER2", hash, "C1", "1.1");
    await recordCrossPost(env.DEDUPE, "U_SPAMMER2", hash, "C2", "1.2");
    const third = await recordCrossPost(env.DEDUPE, "U_SPAMMER2", hash, "C3", "1.3");
    expect(third.shouldAlert).toBe(true);
    expect(third.occurrences).toHaveLength(3);

    // A 4th channel shouldn't re-alert.
    const fourth = await recordCrossPost(env.DEDUPE, "U_SPAMMER2", hash, "C4", "1.4");
    expect(fourth.shouldAlert).toBe(false);
    expect(fourth.occurrences).toHaveLength(4);
  });

  it("does not double-count the same channel posted to twice", async () => {
    const hash = await hashMessageText("spam message three");
    await recordCrossPost(env.DEDUPE, "U_SPAMMER3", hash, "C1", "1.1");
    const repeat = await recordCrossPost(env.DEDUPE, "U_SPAMMER3", hash, "C1", "1.2");
    expect(repeat.occurrences).toHaveLength(1);
  });

  it("tracks different authors independently even with identical text", async () => {
    const hash = await hashMessageText("shared exact text");
    await recordCrossPost(env.DEDUPE, "U_AUTHOR_A", hash, "C1", "1.1");
    const other = await recordCrossPost(env.DEDUPE, "U_AUTHOR_B", hash, "C1", "2.1");
    expect(other.occurrences).toHaveLength(1); // not 2 — different author, different key
  });
});

describe("recordRepeatFlag", () => {
  it("counts up across separate calls for the same author", async () => {
    const first = await recordRepeatFlag(env.DEDUPE, "U_REPEAT1");
    const second = await recordRepeatFlag(env.DEDUPE, "U_REPEAT1");
    const third = await recordRepeatFlag(env.DEDUPE, "U_REPEAT1");
    expect([first, second, third]).toEqual([1, 2, 3]);
  });

  it("tracks different authors independently", async () => {
    await recordRepeatFlag(env.DEDUPE, "U_REPEAT2");
    await recordRepeatFlag(env.DEDUPE, "U_REPEAT2");
    const other = await recordRepeatFlag(env.DEDUPE, "U_REPEAT3");
    expect(other).toBe(1);
  });
});
