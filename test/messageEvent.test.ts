import { describe, expect, it, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { handleMessageEvent, type MessageEnv, type MessageChannelsEvent } from "../src/handlers/messageEvent";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeEnv(): MessageEnv {
  return { DEDUPE: env.DEDUPE, SLACK_BOT_TOKEN: "xoxb-test", SHADOW_ALERTS_CHANNEL: "C0SHADOW", OPENAI_API_KEY: "sk-test" };
}

interface ModerationStub {
  flagged: boolean;
  categories?: Partial<Record<string, boolean>>;
  scores?: Partial<Record<string, number>>;
}

function stubFetch(calls: { url: string; body: string }[], moderation: ModerationStub = { flagged: false }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);

      if (url.includes("chat.getPermalink")) {
        return new Response(JSON.stringify({ ok: true, permalink: `https://hesa.slack.com/archives/${url}` }), { status: 200 });
      }
      if (url.includes("api.openai.com/v1/moderations")) {
        const base = { harassment: false, "harassment/threatening": false, hate: false, "hate/threatening": false };
        const baseScores = { harassment: 0, "harassment/threatening": 0, hate: 0, "hate/threatening": 0 };
        return new Response(
          JSON.stringify({
            results: [{ categories: { ...base, ...moderation.categories }, category_scores: { ...baseScores, ...moderation.scores } }],
          }),
          { status: 200 },
        );
      }
      if (url.includes("conversations.history")) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { user: "U_SPAMMER", ts: "1.1", text: "the flagged message itself" },
              { user: "U_OTHER", ts: "1.0", text: "an earlier message for context" },
            ],
          }),
          { status: 200 },
        );
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

  it("still runs moderation scoring on short messages, unlike cross-post's length filter", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls, { flagged: true, categories: { hate: true }, scores: { hate: 0.91 } });
    await handleMessageEvent(makeEnv(), messageEvent({ text: "lol" }));
    const alertCalls = calls.filter((c) => c.url.includes("chat.postMessage"));
    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0]!.body).toContain("harassment/hate");
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

  it("notes a repeat pattern on a second, separate incident from the same author, not the first", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);
    const messageEnv = makeEnv();
    const user = "U_REPEAT_OFFENDER";

    // First incident: a distinct message, own burst of 3 channels.
    await handleMessageEvent(messageEnv, messageEvent({ user, text: "First spam message here today", channel: "C1", ts: "1.1" }));
    await handleMessageEvent(messageEnv, messageEvent({ user, text: "First spam message here today", channel: "C2", ts: "1.2" }));
    await handleMessageEvent(messageEnv, messageEvent({ user, text: "First spam message here today", channel: "C3", ts: "1.3" }));

    // Second, unrelated-text incident from the same author.
    await handleMessageEvent(messageEnv, messageEvent({ user, text: "Second unrelated spam message", channel: "C1", ts: "2.1" }));
    await handleMessageEvent(messageEnv, messageEvent({ user, text: "Second unrelated spam message", channel: "C2", ts: "2.2" }));
    await handleMessageEvent(messageEnv, messageEvent({ user, text: "Second unrelated spam message", channel: "C3", ts: "2.3" }));

    const alertCalls = calls.filter((c) => c.url.includes("chat.postMessage"));
    expect(alertCalls).toHaveLength(2);
    expect(alertCalls[0]!.body).not.toContain("Repeat pattern");
    expect(alertCalls[1]!.body).toContain("Repeat pattern");
    expect(alertCalls[1]!.body).toContain("2nd cross-post flag");
  });
});

describe("handleMessageEvent — moderation scoring", () => {
  it("does not alert when the message isn't flagged", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls, { flagged: false });
    await handleMessageEvent(makeEnv(), messageEvent({ text: "Has anyone taken STAT 100 with Professor Lee?" }));
    expect(calls.filter((c) => c.url.includes("chat.postMessage"))).toHaveLength(0);
  });

  it("alerts with scores and preceding context when flagged", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls, { flagged: true, categories: { harassment: true }, scores: { harassment: 0.88 } });
    await handleMessageEvent(makeEnv(), messageEvent({ text: "a genuinely hostile message aimed at someone" }));

    const alertCalls = calls.filter((c) => c.url.includes("chat.postMessage"));
    expect(alertCalls).toHaveLength(1);
    expect(alertCalls[0]!.body).toContain("harassment: 0.88");
    expect(alertCalls[0]!.body).toContain("an earlier message for context");
  });

  it("does not let a moderation-scoring failure block cross-post detection", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("api.openai.com")) {
          return new Response("server error", { status: 500 });
        }
        if (url.includes("chat.getPermalink")) {
          return new Response(JSON.stringify({ ok: true, permalink: "https://hesa.slack.com/x" }), { status: 200 });
        }
        calls.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const messageEnv = makeEnv();
    await handleMessageEvent(messageEnv, messageEvent({ channel: "C1", ts: "1.1", text: "Failure-tolerant burst message" }));
    await handleMessageEvent(messageEnv, messageEvent({ channel: "C2", ts: "1.2", text: "Failure-tolerant burst message" }));
    await handleMessageEvent(messageEnv, messageEvent({ channel: "C3", ts: "1.3", text: "Failure-tolerant burst message" }));

    expect(calls.filter((c) => c.url.includes("chat.postMessage"))).toHaveLength(1);
  });
});
