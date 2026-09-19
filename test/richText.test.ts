import { describe, expect, it } from "vitest";
import { richTextToString } from "../src/slack/richText";

describe("richTextToString", () => {
  it("preserves @-mentions as Slack user-id tokens, never resolved names", () => {
    const value = {
      type: "rich_text" as const,
      elements: [
        {
          type: "rich_text_section",
          elements: [
            { type: "text", text: "Mostly " },
            { type: "user", user_id: "U0ACCUSED" },
            { type: "text", text: " was involved." },
          ],
        },
      ],
    };

    expect(richTextToString(value)).toBe("Mostly <@U0ACCUSED> was involved.");
  });

  it("returns an empty string for an empty or missing value", () => {
    expect(richTextToString(undefined)).toBe("");
    expect(richTextToString({ type: "rich_text", elements: [] })).toBe("");
  });

  it("joins multiple sections with newlines", () => {
    const value = {
      type: "rich_text" as const,
      elements: [
        { type: "rich_text_section", elements: [{ type: "text", text: "First line." }] },
        { type: "rich_text_section", elements: [{ type: "text", text: "Second line." }] },
      ],
    };

    expect(richTextToString(value)).toBe("First line.\nSecond line.");
  });
});
