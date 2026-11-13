import { describe, expect, it } from "vitest";

import { invalidTimeWindows, validTimeWindows } from "../../../tests/shared/time-windows-cases";
import { timeWindowsSchema, toMinutes } from "./time-windows";

describe("timeWindowsSchema", () => {
  it.each(validTimeWindows)("accepts %s", (_label, value) => {
    expect(timeWindowsSchema.safeParse(value).success).toBe(true);
  });

  it.each(invalidTimeWindows)("rejects %s", (_label, value) => {
    expect(timeWindowsSchema.safeParse(value).success).toBe(false);
  });
});

describe("toMinutes", () => {
  it("handles midnight and end of day", () => {
    expect(toMinutes("00:00")).toBe(0);
    expect(toMinutes("13:45")).toBe(825);
    expect(toMinutes("24:00")).toBe(1440);
  });
});
