import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { recordFlag, formatFlagSummary } from "../src/repeatFlags";

describe("recordFlag", () => {
  it("counts up across separate calls for the same author, regardless of type", async () => {
    const first = await recordFlag(env.DEDUPE, "U_REPEAT1", "cross_post");
    const second = await recordFlag(env.DEDUPE, "U_REPEAT1", "member_flag");
    const third = await recordFlag(env.DEDUPE, "U_REPEAT1", "moderation_flag");
    expect([first.total, second.total, third.total]).toEqual([1, 2, 3]);
    expect(third.counts).toEqual({ cross_post: 1, member_flag: 1, moderation_flag: 1 });
  });

  it("tracks different authors independently", async () => {
    await recordFlag(env.DEDUPE, "U_REPEAT2", "cross_post");
    await recordFlag(env.DEDUPE, "U_REPEAT2", "cross_post");
    const other = await recordFlag(env.DEDUPE, "U_REPEAT3", "cross_post");
    expect(other.total).toBe(1);
  });

  it("breaks out repeated flags of the same type correctly", async () => {
    await recordFlag(env.DEDUPE, "U_REPEAT4", "cross_post");
    await recordFlag(env.DEDUPE, "U_REPEAT4", "cross_post");
    const third = await recordFlag(env.DEDUPE, "U_REPEAT4", "member_flag");
    expect(third).toEqual({ total: 3, counts: { cross_post: 2, member_flag: 1, moderation_flag: 0 } });
  });
});

describe("formatFlagSummary", () => {
  it("formats a mixed summary with correct pluralization", () => {
    const text = formatFlagSummary({ total: 4, counts: { cross_post: 2, member_flag: 1, moderation_flag: 1 } });
    expect(text).toBe("4 total (2 cross-posts, 1 member flag, 1 content flag)");
  });

  it("omits zero-count types entirely", () => {
    const text = formatFlagSummary({ total: 2, counts: { cross_post: 2, member_flag: 0, moderation_flag: 0 } });
    expect(text).toBe("2 total (2 cross-posts)");
  });
});
