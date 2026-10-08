import { describe, expect, it } from "vitest";
import { statusFromLabel, STATUS_LABELS, type ApplicantStatus } from "../src/verification/schema";

describe("statusFromLabel", () => {
  it("maps every known label back to its code", () => {
    for (const [code, label] of Object.entries(STATUS_LABELS) as [ApplicantStatus, string][]) {
      expect(statusFromLabel(label)).toBe(code);
    }
  });

  it("returns undefined for unrecognized or mismatched text", () => {
    expect(statusFromLabel("Degree candidate — undergraduate (ALB)")).toBeUndefined(); // em dash, not a hyphen
    expect(statusFromLabel("")).toBeUndefined();
    expect(statusFromLabel("2")).toBeUndefined(); // the raw numeric recode value, not a label
  });
});
