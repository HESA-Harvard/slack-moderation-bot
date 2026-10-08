import { describe, expect, it, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { handleReconfirmationSubmit, RECONFIRMATIONS_TAB, type ReconfirmationEnv } from "../src/handlers/reconfirmation";
import type { ReconfirmationSubmission } from "../src/verification/schema";
import { fakeServiceAccountKey } from "./helpers/fakeServiceAccountKey";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeEnv(): Promise<ReconfirmationEnv> {
  return {
    DEDUPE: env.DEDUPE,
    GOOGLE_SA_KEY: await fakeServiceAccountKey(),
    ACCESS_ROSTER_SHEET_ID: "sheet123",
    SLACK_BOT_TOKEN: "xoxb-test",
    ACCESS_QUEUE_CHANNEL: "C0ACCESS",
  };
}

function stubFetch(calls: { url: string; body: string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
      }
      calls.push({ url, body: String(init?.body ?? "") });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
}

const submission: ReconfirmationSubmission = {
  full_name: "Jamie Rivera",
  email: "jamie@g.harvard.edu",
  submitted_at: "2026-10-08T00:00:00.000Z",
};

describe("handleReconfirmationSubmit", () => {
  it("appends a row to the Reconfirmations tab with timestamp, email, full_name", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);

    await handleReconfirmationSubmit(await makeEnv(), submission);

    const call = calls.find((c) => c.url.includes("sheets.googleapis.com"));
    expect(call).toBeDefined();
    expect(call!.url).toContain("sheet123");
    expect(call!.url).toContain(RECONFIRMATIONS_TAB);
    const [row] = JSON.parse(call!.body).values as string[][];
    expect(row).toEqual([submission.submitted_at, submission.email, submission.full_name]);
  });

  it("does not post anything to Slack when the write succeeds", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);

    await handleReconfirmationSubmit(await makeEnv(), submission);

    expect(calls.some((c) => c.url.includes("slack.com"))).toBe(false);
  });

  it("posts a visible warning to #access-queue, not a silent failure, when the sheet write fails", async () => {
    const slackCalls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
        }
        if (url.includes("sheets.googleapis.com")) {
          return new Response("server error", { status: 500 });
        }
        slackCalls.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    await handleReconfirmationSubmit(await makeEnv(), submission);

    const alertCall = slackCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(alertCall).toBeDefined();
    expect(alertCall!.body).toContain("Reconfirmation write failed");
    expect(alertCall!.body).toContain(submission.email);
  });
});
