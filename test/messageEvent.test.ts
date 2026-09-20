import { describe, expect, it, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { handleMessageEvent, type MessageEnv, type MessageChannelsEvent } from "../src/handlers/messageEvent";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeEnv(): MessageEnv {
  return { DEDUPE: env.DEDUPE, SLACK_BOT_TOKEN: "xoxb-test", SHADOW_ALERTS_CHANNEL: "C0SHADOW" };
}

function stubFetch(calls: { url: string; body: string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("chat.getPermalink")) {
        return new Response(JSON.stringify({ ok: true, permalink: `https://hesa.slack.com/archives/${url}` }), { status: 200 });
      }
      calls.push({ url, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
}

function messageEvent(overrides: Partial<MessageChannelsEvent>): MessageChannelsEvent {
  return {
    channel: "C1",
    user: "U_SPAMMER",
    text: "Check out my new startup, everyone should sign up today!",
    ts: "1.1",
    ...overrides,
  };
}

describe("handleMessageEvent", () => {
  it("ignores messages with a subtype (edits, deletes, joins, etc.)", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);
    await handleMessageEvent(makeEnv(), messageEvent({ subtype: "message_changed" }));
    expect(calls).toHaveLength(0);
  });

  it("ignores messages from bots", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);
    await handleMessageEvent(makeEnv(), messageEvent({ bot_id: "B123" }));
    expect(calls).toHaveLength(0);
  });

  it("ignores short messages", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);
    await handleMessageEvent(makeEnv(), messageEvent({ text: "lol" }));
    expect(calls).toHaveLength(0);
  });

  it("posts a shadow-mode alert once the same message crosses 3 channels", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);
    const messageEnv = makeEnv();

    await handleMessageEvent(messageEnv, messageEvent({ channel: "C1", ts: "1.1" }));
    await handleMessageEvent(messageEnv, messageEvent({ channel: "C2", ts: "1.2" }));
    expect(calls.filter((c) => c.url.includes("chat.postMessage"))).toHaveLength(0);

    await handleMessageEvent(messageEnv, messageEvent({ channel: "C3", ts: "1.3" }));
    const alertCalls = calls.filter((c) => c.url.includes("chat.postMessage"));
    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0]!.body).toContain("U_SPAMMER");
    expect(alertCalls[0]!.body).toContain("shadow mode");

    // A 4th channel shouldn't produce a second alert.
    await handleMessageEvent(messageEnv, messageEvent({ channel: "C4", ts: "1.4" }));
    expect(calls.filter((c) => c.url.includes("chat.postMessage"))).toHaveLength(1);
  });
});
