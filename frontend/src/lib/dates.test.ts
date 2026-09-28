import { describe, expect, it } from "vitest";

import { daysBetween } from "./dates";

describe("daysBetween", () => {
  it("counts whole UTC days, across leap days and daylight saving changes", () => {
    expect(daysBetween("2026-06-15", "2026-06-15")).toBe(0);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-01-01", "2027-01-01")).toBe(365);
  });
});
