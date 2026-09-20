import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import {
  recordInviteLinkUse,
  handleInviteLinkRefreshed,
  type InviteLinkGuardEnv,
} from "../src/verification/inviteLinkGuard";

// KV state isn't guaranteed reset between it() blocks in this test runner (see
// dedupe.test.ts's comment-free but deliberate avoidance of exact-value
// assertions for the same reason) — so every test clears these explicitly
// rather than assuming a clean slate. Keys must match inviteLinkGuard.ts.
const USES_KEY = "invite_link:uses";
const WARNED_KEY = "invite_link:warned";

beforeEach(async () => {
  await env.DEDUPE.delete(USES_KEY);
  await env.DEDUPE.delete(WARNED_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeEnv(): InviteLinkGuardEnv {
  return { DEDUPE: env.DEDUPE, SLACK_BOT_TOKEN: "xoxb-test", ACCESS_QUEUE_CHANNEL: "C0ACCESS" };
}

function stubFetch(calls: { url: string; body: string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input instanceof Request ? input.url : input), body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
}

describe("recordInviteLinkUse", () => {
  it("does not post a warning while well under the threshold", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);
    const guardEnv = makeEnv();

    for (let i = 0; i < 5; i++) await recordInviteLinkUse(guardEnv);

    expect(calls).toHaveLength(0);
  });

  it("posts exactly one warning once the threshold is crossed, even across further approvals", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);
    const guardEnv = makeEnv();

    for (let i = 0; i < 355; i++) await recordInviteLinkUse(guardEnv);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("chat.postMessage");
    expect(calls[0]!.body).toContain("running low");
  });
});

describe("handleInviteLinkRefreshed", () => {
  it("resets the counter so warnings can fire again on a new cycle", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);
    const guardEnv = makeEnv();

    for (let i = 0; i < 350; i++) await recordInviteLinkUse(guardEnv);
    expect(calls.filter((c) => c.url.includes("chat.postMessage"))).toHaveLength(1);

    await handleInviteLinkRefreshed(guardEnv, {
      user: { id: "U0MOD" },
      channel: { id: "C0ACCESS" },
      message: { ts: "1.1", blocks: [{ type: "section", text: { type: "mrkdwn", text: "warning" } }] },
    });
    const updateCall = calls.find((c) => c.url.includes("chat.update"));
    expect(updateCall!.body).toContain("Marked refreshed by <@U0MOD>");

    calls.length = 0;
    for (let i = 0; i < 350; i++) await recordInviteLinkUse(guardEnv);
    expect(calls.filter((c) => c.url.includes("chat.postMessage"))).toHaveLength(1);
  });
});
