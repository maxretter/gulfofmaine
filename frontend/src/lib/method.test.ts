import { describe, expect, it } from "vitest";

import { baselineLength, baselineYears, categoryScale, dayCountsFrom, inWords } from "./method";

describe("the method in words", () => {
  it("spells out counts up to twenty", () => {
    expect([0, 2, 5, 20, 21].map(inWords)).toEqual(["zero", "two", "five", "twenty", "21"]);
  });

  it("gives the baseline's years and length, both ends included", () => {
    const baseline = { baseline_start: 2003, baseline_end: 2022 };
    expect(baselineYears(baseline)).toBe("2003–2022");
    expect(baselineLength(baseline)).toBe(20);
  });

  it("gives each category its multiples, the last with any beyond", () => {
    expect(categoryScale({ categories: ["Moderate", "Strong", "Severe", "Extreme"] })).toBe(
      "Moderate (1×), Strong (2×), Severe (3×), Extreme (4× or more)",
    );
  });

  it("says from what hour a day can have its hours", () => {
    expect(dayCountsFrom({ min_hours: 18 })).toBe("18:00 UTC");
    expect(dayCountsFrom({ min_hours: 6 })).toBe("06:00 UTC");
  });
});
