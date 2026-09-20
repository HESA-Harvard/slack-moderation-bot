import { describe, expect, it, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { writeArchiveRecord, appendRosterRow, type ArchiveEnv } from "../src/archive/drive";
import type { IncidentRecord } from "../src/archive/schema";
import { fakeServiceAccountKey } from "./helpers/fakeServiceAccountKey";

const record: IncidentRecord = {
  incident_id: "2026-0001",
  captured_at: "2026-01-01T00:00:00Z",
  source: "emoji",
  anonymous: false,
  reporter_user_id: "U0REPORTER",
  channel: "C0GENERAL",
  permalink: "https://hesa.slack.com/archives/C0GENERAL/p1",
  flagged_message: { user_id: "U0AUTHOR", ts: "1.1", text: "hello" },
  context: [],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("writeArchiveRecord", () => {
  it(
    "posts a loud failure notice to #mod-alerts when every Drive write attempt fails",
    async () => {
      const saKey = await fakeServiceAccountKey();
      const slackCalls: string[] = [];

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input instanceof Request ? input.url : input);

          if (url.includes("oauth2.googleapis.com/token")) {
            return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
          }
          if (url.includes("googleapis.com/upload/drive")) {
            return new Response("server error", { status: 500 });
          }
          if (url.includes("slack.com/api/chat.postMessage")) {
            slackCalls.push(String(init?.body ?? ""));
            return new Response(JSON.stringify({ ok: true }), { status: 200 });
          }
          throw new Error(`unexpected fetch to ${url}`);
        }),
      );

      const archiveEnv: ArchiveEnv = {
        DEDUPE: env.DEDUPE,
        GOOGLE_SA_KEY: saKey,
        ARCHIVE_FOLDER_ID: "folder123",
        SLACK_BOT_TOKEN: "xoxb-test",
        MOD_ALERTS_CHANNEL: "C0MOD",
      };

      await writeArchiveRecord(archiveEnv, record);

      expect(slackCalls).toHaveLength(1);
      expect(slackCalls[0]).toContain("ARCHIVE WRITE FAILED");
      expect(slackCalls[0]).toContain(record.incident_id);
    },
    15000,
  );
});

describe("appendRosterRow", () => {
  it("appends the row to the given sheet/tab and returns true on success", async () => {
    const saKey = await fakeServiceAccountKey();
    const appendCalls: { url: string; body: string }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("oauth2.googleapis.com/token")) {
          return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
        }
        if (url.includes("sheets.googleapis.com")) {
          appendCalls.push({ url, body: String(init?.body ?? "") });
          return new Response(JSON.stringify({}), { status: 200 });
        }
        throw new Error(`unexpected fetch to ${url}`);
      }),
    );

    const ok = await appendRosterRow({ DEDUPE: env.DEDUPE, GOOGLE_SA_KEY: saKey }, "sheet123", "Approvals", [
      "ACCESS-2026-0001",
      "2026-01-01T00:00:00Z",
      "Jamie Rivera",
      "jamie@g.harvard.edu",
      "degree_alm",
      "12345678",
      "U0MOD",
    ]);

    expect(ok).toBe(true);
    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]!.url).toContain("sheet123");
    expect(appendCalls[0]!.url).toContain("Approvals");
    expect(appendCalls[0]!.body).toContain("Jamie Rivera");
  });

  it(
    "retries then returns false, without throwing, when every attempt fails",
    async () => {
      const saKey = await fakeServiceAccountKey();

      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input instanceof Request ? input.url : input);
          if (url.includes("oauth2.googleapis.com/token")) {
            return new Response(JSON.stringify({ access_token: "fake-token", expires_in: 3600 }), { status: 200 });
          }
          if (url.includes("sheets.googleapis.com")) {
            return new Response("server error", { status: 500 });
          }
          throw new Error(`unexpected fetch to ${url}`);
        }),
      );

      const ok = await appendRosterRow({ DEDUPE: env.DEDUPE, GOOGLE_SA_KEY: saKey }, "sheet123", "Approvals", ["row"]);

      expect(ok).toBe(false);
    },
    15000,
  );
});
