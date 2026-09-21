import { describe, expect, it, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { logIncident, INCIDENT_LOG_TAB } from "../src/archive/incidentLog";
import type { ArchiveEnv } from "../src/archive/drive";
import type { EmojiIncidentRecord, ReportIncidentRecord } from "../src/archive/schema";
import { fakeServiceAccountKey } from "./helpers/fakeServiceAccountKey";

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeEnv(): Promise<ArchiveEnv> {
  return {
    DEDUPE: env.DEDUPE,
    GOOGLE_SA_KEY: await fakeServiceAccountKey(),
    ARCHIVE_FOLDER_ID: "folder123",
    SLACK_BOT_TOKEN: "xoxb-test",
    MOD_ALERTS_CHANNEL: "C0MOD",
    INCIDENT_LOG_SHEET_ID: "incidents123",
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

const emojiRecord: EmojiIncidentRecord = {
  incident_id: "2026-0001",
  captured_at: "2026-09-21T00:00:00Z",
  source: "emoji",
  anonymous: false,
  reporter_user_id: "U0REPORTER",
  channel: "C0GENERAL",
  permalink: "https://hesa.slack.com/archives/C0GENERAL/p1",
  flagged_message: { user_id: "U0AUTHOR", ts: "1.1", text: "hello" },
  context: [],
};

describe("logIncident", () => {
  it("appends a row with the flagged user id and archive link, no message text, for an emoji flag", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);

    await logIncident(await makeEnv(), emojiRecord, "https://drive.google.com/file/d/file123/view");

    const call = calls.find((c) => c.url.includes("sheets.googleapis.com"));
    expect(call).toBeDefined();
    expect(call!.url).toContain("incidents123");
    expect(call!.url).toContain(INCIDENT_LOG_TAB);
    expect(call!.body).toContain("2026-0001");
    expect(call!.body).toContain("U0AUTHOR");
    expect(call!.body).toContain("U0REPORTER");
    expect(call!.body).toContain("https://drive.google.com/file/d/file123/view");
    expect(call!.body).not.toContain("hello");
  });

  it("omits the reporter id and leaves flagged_user_id blank for an anonymous report with no referenced message", async () => {
    const calls: { url: string; body: string }[] = [];
    stubFetch(calls);

    const record: ReportIncidentRecord = {
      incident_id: "2026-0002",
      captured_at: "2026-09-21T00:00:00Z",
      source: "report",
      channel: "C0GENERAL",
      permalink: "",
      context: [],
      anonymous: true,
      report_text: "Who was involved: U0ACCUSED\nSomething happened.",
    };

    await logIncident(await makeEnv(), record, undefined);

    const call = calls.find((c) => c.url.includes("sheets.googleapis.com"));
    expect(call).toBeDefined();
    const [row] = JSON.parse(call!.body).values as string[][];
    expect(row).toBeDefined();
    expect(row![0]).toBe("2026-0002"); // incident_id
    expect(row![4]).toBe(""); // flagged_user_id — free text "who was involved" isn't a reliable id
    expect(row![5]).toBe(""); // reporter_user_id — withheld, anonymous
    expect(row![6]).toBe("yes"); // anonymous
    expect(call!.body).not.toContain("U0ACCUSED");
  });

  it("posts a visible warning to #mod-alerts, not a silent failure, when the sheet write fails", async () => {
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

    await logIncident(await makeEnv(), emojiRecord, "https://drive.google.com/file/d/file123/view");

    const alertCall = slackCalls.find((c) => c.url.includes("chat.postMessage"));
    expect(alertCall).toBeDefined();
    expect(alertCall!.body).toContain("Incident-log write failed");
    expect(alertCall!.body).toContain("2026-0001");
  });
});
