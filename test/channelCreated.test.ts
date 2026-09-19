import { describe, expect, it, vi, afterEach } from "vitest";
import { handleChannelCreated, type ChannelCreatedEnv } from "../src/handlers/channelCreated";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("handleChannelCreated", () => {
  it("joins the newly created channel", async () => {
    const calls: { url: string; body: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        calls.push({ url, body: String(init?.body ?? "") });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const env: ChannelCreatedEnv = { SLACK_BOT_TOKEN: "xoxb-test" };
    await handleChannelCreated(env, { channel: { id: "C0NEWCHANNEL", name: "new-channel" } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("conversations.join");
    expect(calls[0]!.body).toContain("C0NEWCHANNEL");
  });
});
