import { describe, expect, it, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import {
  handleVerificationSubmit,
  handleVerificationAction,
  isVerificationAction,
  type VerificationEnv,
} from "../src/handlers/verification";
import type { VerificationSubmission } from "../src/verification/schema";
import { fakeServiceAccountKey } from "./helpers/fakeServiceAccountKey";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeEnv(): Promise<VerificationEnv> {
  return {
    DEDUPE: env.DEDUPE,
    SLACK_BOT_TOKEN: "xoxb-test",
    ACCESS_QUEUE_CHANNEL: "C0ACCESS",
    FORM_CALLBACK_URL: "https://script.google.com/macros/s/fake/exec",
    FORM_INTEGRATION_SECRET: "shh",
    GOOGLE_SA_KEY: await fakeServiceAccountKey(),
    ACCESS_ROSTER_SHEET_ID: "sheet123",
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

describe("handleVerificationSubmit", () => {
  it("posts an alert with the degree/harvard-email mismatch warning when applicable", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);

    const submission: VerificationSubmission = {
      full_name: "Jamie Rivera",
      email: "jamie.rivera@gmail.com",
      email_verified: true,
      status: "degree_alm",
      huid: "12345678",
      submitted_at: "2026-09-22T10:00:00.000Z",
    };
    await handleVerificationSubmit(await makeEnv(), submission);

    const alertCall = calls.find((c) => c.url.includes("chat.postMessage"));
    expect(alertCall).toBeDefined();
    expect(alertCall!.body).toContain('Claims \\"Degree candidate - graduate (ALM)\\" but verified email isn');
  });

  it("does not warn for a course-taker without a harvard.edu email", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);

    const submission: VerificationSubmission = {
      full_name: "Sam Lee",
      email: "sam.lee@gmail.com",
      email_verified: true,
      status: "course_taker",
      huid: "87654321",
      submitted_at: "2026-09-22T10:00:00.000Z",
    };
    await handleVerificationSubmit(await makeEnv(), submission);

    const alertCall = calls.find((c) => c.url.includes("chat.postMessage"));
    expect(alertCall!.body).not.toContain("warning");
  });

  it("shows a visible fallback rather than the literal string 'undefined' for an unrecognized status", async () => {
    // Regression test: a live submission hit this when the Form's option text
    // drifted out of sync with access-queue.gs's STATUS_OPTION_TO_CODE, and
    // the alert rendered "*Status:* undefined" verbatim.
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);

    const submission = {
      full_name: "Alex Kim",
      email: "alex.kim@gmail.com",
      email_verified: true,
      status: undefined as unknown as VerificationSubmission["status"],
      huid: "11223344",
      submitted_at: "2026-09-22T10:00:00.000Z",
    };
    await handleVerificationSubmit(await makeEnv(), submission);

    const alertCall = calls.find((c) => c.url.includes("chat.postMessage"));
    expect(alertCall!.body).not.toContain("*Status:* undefined");
    expect(alertCall!.body).toContain("unrecognized");
  });

  it("reads the roster's Removed tab and warns when the applicant has a prior conduct removal", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
        }
        if (url.includes("sheets.googleapis.com") && url.includes("Removed")) {
          return new Response(
            JSON.stringify({
              values: [
                ["email", "removed_at", "removed_by", "reason_category", "notes"],
                ["other@gmail.com", "2026-01-01T00:00:00.000Z", "U0MOD1", "lapsed", ""],
                ["jamie.rivera@gmail.com", "2026-02-01T00:00:00.000Z", "U0MOD2", "conduct", "Harassment — see incident 2026-0004"],
              ],
            }),
            { status: 200 },
          );
        }
        calls.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const submission: VerificationSubmission = {
      full_name: "Jamie Rivera",
      email: "jamie.rivera@gmail.com",
      email_verified: true,
      status: "course_taker",
      huid: "12345678",
      submitted_at: "2026-09-22T10:00:00.000Z",
    };
    await handleVerificationSubmit(await makeEnv(), submission);

    const alertCall = calls.find((c) => c.url.includes("chat.postMessage"));
    expect(alertCall).toBeDefined();
    expect(alertCall!.body).toContain("Previously removed for conduct");
    expect(alertCall!.body).toContain("U0MOD2");
    expect(alertCall!.body).toContain("Harassment");
    expect(alertCall!.body).toContain("Do not approve without review");
  });

  it("does not warn for a prior removal that was routine (lapsed), not conduct", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
        }
        if (url.includes("sheets.googleapis.com") && url.includes("Removed")) {
          return new Response(
            JSON.stringify({
              values: [
                ["email", "removed_at", "removed_by", "reason_category", "notes"],
                ["jamie.rivera@gmail.com", "2026-02-01T00:00:00.000Z", "U0MOD2", "lapsed", "didn't reconfirm"],
              ],
            }),
            { status: 200 },
          );
        }
        calls.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const submission: VerificationSubmission = {
      full_name: "Jamie Rivera",
      email: "jamie.rivera@gmail.com",
      email_verified: true,
      status: "course_taker",
      huid: "12345678",
      submitted_at: "2026-09-22T10:00:00.000Z",
    };
    await handleVerificationSubmit(await makeEnv(), submission);

    const alertCall = calls.find((c) => c.url.includes("chat.postMessage"));
    expect(alertCall!.body).not.toContain("Previously removed");
  });

  it("still posts the alert even if the Removed-tab read fails", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
        }
        if (url.includes("sheets.googleapis.com") && url.includes("Removed")) {
          return new Response("server error", { status: 500 });
        }
        calls.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const submission: VerificationSubmission = {
      full_name: "Jamie Rivera",
      email: "jamie.rivera@gmail.com",
      email_verified: true,
      status: "course_taker",
      huid: "12345678",
      submitted_at: "2026-09-22T10:00:00.000Z",
    };
    await handleVerificationSubmit(await makeEnv(), submission);

    const alertCall = calls.find((c) => c.url.includes("chat.postMessage"));
    expect(alertCall).toBeDefined();
    expect(alertCall!.body).not.toContain("Previously removed");
  });
});

describe("isVerificationAction", () => {
  it("recognizes the three verification button action ids and nothing else", () => {
    expect(isVerificationAction({ type: "block_actions", actions: [{ action_id: "verify_approve" }] })).toBe(true);
    expect(isVerificationAction({ type: "block_actions", actions: [{ action_id: "verify_more_info" }] })).toBe(true);
    expect(isVerificationAction({ type: "block_actions", actions: [{ action_id: "verify_deny" }] })).toBe(true);
    expect(isVerificationAction({ type: "block_actions", actions: [{ action_id: "something_else" }] })).toBe(false);
    expect(isVerificationAction({ type: "view_submission" })).toBe(false);
  });
});

describe("handleVerificationAction", () => {
  it("calls the Apps Script callback and appends a status line to the existing message", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);

    const payload = {
      type: "block_actions" as const,
      user: { id: "U0MOD" },
      channel: { id: "C0ACCESS" },
      message: { ts: "1.1", blocks: [{ type: "section", text: { type: "mrkdwn", text: "original" } }] },
      actions: [
        {
          action_id: "verify_approve",
          value: JSON.stringify({ full_name: "Jamie Rivera", email: "jamie@g.harvard.edu", status: "degree_alm", huid: "12345678" }),
        },
      ],
    };

    await handleVerificationAction(await makeEnv(), payload);

    const callbackCall = calls.find((c) => c.url.includes("script.google.com"));
    expect(callbackCall).toBeDefined();
    expect(callbackCall!.body).toContain("jamie@g.harvard.edu");
    expect(callbackCall!.body).toContain('"action":"approve"');
    // Apps Script's more_info template conditionally suggests a g.harvard.edu resubmit
    // based on this — see access-queue.gs's shouldSuggestHarvardEmail.
    expect(callbackCall!.body).toContain('"status":"degree_alm"');

    const updateCall = calls.find((c) => c.url.includes("chat.update"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.body).toContain("Approved by <@U0MOD>");
    // The original block content must survive the update, not just the new status line.
    expect(updateCall!.body).toContain("original");

    const rosterCall = calls.find((c) => c.url.includes("sheets.googleapis.com"));
    expect(rosterCall).toBeDefined();
    expect(rosterCall!.url).toContain("sheet123");
    expect(rosterCall!.url).toContain("Approvals");
    expect(rosterCall!.body).toContain("Jamie Rivera");
    expect(rosterCall!.body).toContain("jamie@g.harvard.edu");
    expect(rosterCall!.body).toContain("12345678");
    expect(rosterCall!.body).toContain("U0MOD");
  });

  it("does not write to the roster on Deny or Request info", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);

    const payload = {
      type: "block_actions" as const,
      user: { id: "U0MOD" },
      channel: { id: "C0ACCESS" },
      message: { ts: "1.1", blocks: [] },
      actions: [
        {
          action_id: "verify_deny",
          value: JSON.stringify({ full_name: "Jamie Rivera", email: "jamie@g.harvard.edu", status: "degree_alm", huid: "12345678" }),
        },
      ],
    };

    await handleVerificationAction(await makeEnv(), payload);

    expect(calls.some((c) => c.url.includes("sheets.googleapis.com"))).toBe(false);
  });
});
