import { describe, expect, it } from "vitest";

import { formatBytes, formatDate, formatList, formatPercent, formatSigned, formatTemp, formatTime } from "./format";

describe("formatting", () => {
  it("signs anomalies with a true minus, and none on values that round to zero", () => {
    expect(formatSigned(2.25)).toBe("+2.3 °C");
    expect(formatSigned(-1.34)).toBe("−1.3 °C");
    expect(formatSigned(-0.04)).toBe("0.0 °C");
    expect(formatSigned(null)).toBe("–");
  });

  it("formats file sizes in decimal units", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(941_336)).toBe("941 KB");
    expect(formatBytes(2_046_307)).toBe("2.0 MB");
  });

  it("formats temperatures and UTC dates", () => {
    expect(formatTemp(14.87)).toBe("14.9 °C");
    // A UTC day must not shift to the previous day in western time zones.
    expect(formatDate("2021-06-15")).toBe("Jun 15, 2021");
  });

  it("gives a reading's time in UTC, with its date unless it's from today", () => {
    const now = new Date("2026-09-29T02:40:00Z");
    expect(formatTime("2026-09-29T02:00:00Z", now)).toBe("02:00 UTC");
    expect(formatTime("2025-09-17T09:00:00Z", now)).toBe("Sep 17, 2025, 09:00 UTC");
  });

  it("lists items in running text, and shares as whole percentages", () => {
    expect(formatList([1, 20, 50])).toBe("1, 20 and 50");
    expect(formatList([20, 50])).toBe("20 and 50");
    expect(formatList([1])).toBe("1");
    expect(formatPercent(0.684)).toBe("68%");
    expect(formatPercent(0.346)).toBe("35%");
  });
});
