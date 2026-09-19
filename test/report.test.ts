import { describe, expect, it, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { handleReportSubmission, type ReportEnv } from "../src/handlers/report";
import { fakeServiceAccountKey } from "./helpers/fakeServiceAccountKey";
import viewSubmissionFixture from "./fixtures/view_submission.json";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(capture: { driveBody?: string; slackCalls: { url: string; body: string }[] }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);

      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
      }
      if (url.includes("googleapis.com/upload/drive")) {
        capture.driveBody = String(init?.body ?? "");
        return new Response(JSON.stringify({ id: "file123" }), { status: 200 });
      }
      if (url.includes("slack.com/api/")) {
        capture.slackCalls.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      throw new Error(`unexpected fetch to ${url}`);
    }),
  );
}

describe("handleReportSubmission", () => {
  it("omits the reporter's id from the archive record and the alert (but not the ephemeral confirmation) when filed anonymously", async () => {
    const capture: { driveBody?: string; slackCalls: { url: string; body: string }[] } = { slackCalls: [] };
    stubFetch(capture);

    const reportEnv: ReportEnv = {
      DEDUPE: env.DEDUPE,
      GOOGLE_SA_KEY: await fakeServiceAccountKey(),
      ARCHIVE_FOLDER_ID: "folder123",
      SLACK_BOT_TOKEN: "xoxb-test",
      MOD_ALERTS_CHANNEL: "C0MOD",
    };

    // fixture's file_as = "anonymous"
    await handleReportSubmission(reportEnv, viewSubmissionFixture as never);

    expect(capture.driveBody).toBeDefined();
    expect(capture.driveBody).not.toContain("U0REPORTER");
    // "Who was involved" mention and the datetimepicker value should still make it through.
    expect(capture.driveBody).toContain("U0ACCUSED");
    expect(capture.driveBody).toContain("2026-09-19T15:00:00");

    const alertCall = capture.slackCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(alertCall).toBeDefined();
    expect(alertCall!.body).not.toContain("U0REPORTER");
    expect(alertCall!.body).toContain("Filed anonymously");
    // The incident id should be hyperlinked to the archived file.
    expect(alertCall!.body).toContain("https://drive.google.com/file/d/file123/view");
    // The "Where" field (fixture selects C0GENERAL) must be visible in the alert,
    // not just the archive file — moderators shouldn't have to open Drive to see it.
    expect(alertCall!.body).toContain("C0GENERAL");
  });
});
