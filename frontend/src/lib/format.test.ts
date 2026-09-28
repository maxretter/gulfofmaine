import { describe, expect, it } from "vitest";

import { formatDate, formatSigned, formatTemp } from "./format";

describe("formatting", () => {
  it("signs anomalies with a true minus, and none on values that round to zero", () => {
    expect(formatSigned(2.25)).toBe("+2.3 °C");
    expect(formatSigned(-1.34)).toBe("−1.3 °C");
    expect(formatSigned(-0.04)).toBe("0.0 °C");
    expect(formatSigned(null)).toBe("–");
  });

  it("formats temperatures and UTC dates", () => {
    expect(formatTemp(14.87)).toBe("14.9 °C");
    // A UTC day must not shift to the previous day in western time zones.
    expect(formatDate("2021-06-15")).toBe("Jun 15, 2021");
  });
});
