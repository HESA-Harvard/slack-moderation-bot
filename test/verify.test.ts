import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "../src/slack/verify";

const SECRET = "test-signing-secret";

async function sign(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v0:${timestamp}:${body}`));
  const hex = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `v0=${hex}`;
}

describe("verifySlackSignature", () => {
  const body = JSON.stringify({ hello: "world" });

  it("accepts a validly signed, fresh request", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = await sign(SECRET, timestamp, body);
    expect(await verifySlackSignature(SECRET, timestamp, signature, body)).toBe(true);
  });

  it("rejects a bad signature", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    expect(await verifySlackSignature(SECRET, timestamp, "v0=deadbeef", body)).toBe(false);
  });

  it("rejects a timestamp older than 5 minutes", async () => {
    const timestamp = String(Math.floor(Date.now() / 1000) - 6 * 60);
    const signature = await sign(SECRET, timestamp, body);
    expect(await verifySlackSignature(SECRET, timestamp, signature, body)).toBe(false);
  });

  it("rejects when headers are missing", async () => {
    expect(await verifySlackSignature(SECRET, null, null, body)).toBe(false);
  });
});
