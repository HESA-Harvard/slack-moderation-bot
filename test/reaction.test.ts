import { describe, expect, it, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { handleReactionAdded, type ReactionEnv, type ReactionAddedEvent } from "../src/handlers/reaction";
import { fakeServiceAccountKey } from "./helpers/fakeServiceAccountKey";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(postCount: { alerts: number }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);

      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("googleapis.com/upload/drive")) {
        return new Response(JSON.stringify({ id: "file123" }), { status: 200 });
      }
      if (url.includes("slack.com/api/conversations.history")) {
        return new Response(
          JSON.stringify({
            ok: true,
            messages: [
              { user: "U0AUTHOR", ts: "1.3", text: "spam spam spam" },
              { user: "U0OTHER", ts: "1.2", text: "hi" },
              { user: "U0OTHER2", ts: "1.1", text: "hello" },
            ],
          }),
          { status: 200 },
        );
      }
      if (url.includes("slack.com/api/chat.getPermalink")) {
        return new Response(JSON.stringify({ ok: true, permalink: "https://hesa.slack.com/archives/x/p1" }), {
          status: 200,
        });
      }
      if (url.includes("slack.com/api/chat.postMessage")) {
        postCount.alerts += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("sheets.googleapis.com")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
}

async function makeReactionEnv(): Promise<ReactionEnv> {
  return {
    DEDUPE: env.DEDUPE,
    GOOGLE_SA_KEY: await fakeServiceAccountKey(),
    ARCHIVE_FOLDER_ID: "folder123",
    SLACK_BOT_TOKEN: "xoxb-test",
    MOD_ALERTS_CHANNEL: "C0MOD",
    FLAG_EMOJI: "flag-for-review",
    INCIDENT_LOG_SHEET_ID: "incidents123",
  };
}

function flagEvent(): ReactionAddedEvent {
  return {
    reaction: "flag-for-review",
    user: "U0REPORTER",
    item: { type: "message", channel: "C0GENERAL", ts: "1.3" },
  };
}

describe("handleReactionAdded", () => {
  it("ignores reactions that are not the configured flag emoji", async () => {
    const postCount = { alerts: 0 };
    stubFetch(postCount);
    const reactionEnv = await makeReactionEnv();

    await handleReactionAdded(reactionEnv, { ...flagEvent(), reaction: "thumbsup" });

    expect(postCount.alerts).toBe(0);
  });

  it("posts exactly one alert even when the same message is flagged twice", async () => {
    const postCount = { alerts: 0 };
    stubFetch(postCount);
    const reactionEnv = await makeReactionEnv();

    await handleReactionAdded(reactionEnv, flagEvent());
    await handleReactionAdded(reactionEnv, { ...flagEvent(), user: "U0SECONDREPORTER" });

    expect(postCount.alerts).toBe(1);
  });
});
