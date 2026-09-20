import { describe, expect, it, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import {
  handleVerificationSubmit,
  handleVerificationAction,
  isVerificationAction,
  type VerificationEnv,
} from "../src/handlers/verification";
import type { VerificationSubmission } from "../src/verification/schema";

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeEnv(): VerificationEnv {
  return {
    DEDUPE: env.DEDUPE,
    SLACK_BOT_TOKEN: "xoxb-test",
    ACCESS_QUEUE_CHANNEL: "C0ACCESS",
    FORM_CALLBACK_URL: "https://script.google.com/macros/s/fake/exec",
    FORM_INTEGRATION_SECRET: "shh",
  };
}

function stubFetch(calls: { url: string; body: string }[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
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
    await handleVerificationSubmit(makeEnv(), submission);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("chat.postMessage");
    expect(calls[0]!.body).toContain('Claims \\"Degree candidate - graduate (ALM)\\" but verified email isn');
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
    await handleVerificationSubmit(makeEnv(), submission);

    expect(calls[0]!.body).not.toContain("warning");
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
    await handleVerificationSubmit(makeEnv(), submission);

    expect(calls[0]!.body).not.toContain("*Status:* undefined");
    expect(calls[0]!.body).toContain("unrecognized");
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
          value: JSON.stringify({ full_name: "Jamie Rivera", email: "jamie@g.harvard.edu", status: "degree_alm" }),
        },
      ],
    };

    await handleVerificationAction(makeEnv(), payload);

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
  });
});
