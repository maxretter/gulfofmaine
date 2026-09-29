import { describe, expect, it } from "vitest";

import { daysBetween, earliest, latest } from "./dates";

describe("daysBetween", () => {
  it("counts whole UTC days, across leap days and daylight saving changes", () => {
    expect(daysBetween("2026-06-15", "2026-06-15")).toBe(0);
    expect(daysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(daysBetween("2026-01-01", "2027-01-01")).toBe(365);
  });
});

describe("latest and earliest", () => {
  it("skip missing values, and give null when there are none", () => {
    expect(latest(["2021-04-14", null, "2025-09-16", undefined])).toBe("2025-09-16");
    expect(earliest(["2021-04-14", null, "2003-07-09"])).toBe("2003-07-09");
    expect(latest([])).toBeNull();
    expect(earliest([null, null])).toBeNull();
  });
});
