import { describe, expect, it } from "vitest";

import { daysBetween, earliest, latest, wholeYear, yearSpan } from "./dates";

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

describe("whole years in a record", () => {
  const first = "2001-07-10";
  const last = "2026-09-29";

  it("clamps a year to the record at either end", () => {
    expect(yearSpan(2021, first, last)).toEqual({ from: "2021-01-01", to: "2021-12-31" });
    expect(yearSpan(2001, first, last)).toEqual({ from: "2001-07-10", to: "2001-12-31" });
    expect(yearSpan(2026, first, last)).toEqual({ from: "2026-01-01", to: "2026-09-29" });
  });

  it("recognizes a period that is exactly one of those years", () => {
    expect(wholeYear("2021-01-01", "2021-12-31", first, last)).toBe(2021);
    expect(wholeYear("2026-01-01", "2026-09-29", first, last)).toBe(2026);
    expect(wholeYear("2021-01-01", "2021-12-30", first, last)).toBeNull();
    expect(wholeYear("2021-03-25", "2022-02-14", first, last)).toBeNull();
  });
});
