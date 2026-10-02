import { formatDay, parseDay } from "./dates";

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

const monthFormat = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
const longMonthFormat = new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric", timeZone: "UTC" });

const timeFormat = new Intl.DateTimeFormat("en-US", {
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
  timeZone: "UTC",
});

export function formatTemp(value: number | null | undefined): string {
  return value == null ? "–" : `${value.toFixed(1)} °C`;
}

/** Signed, with a true minus sign; values that round to zero get no sign. `unit` "" for none, as for salinity. */
export function formatSigned(value: number | null | undefined, unit = "°C", digits = 1): string {
  if (value == null) return "–";
  const rounded = value.toFixed(digits);
  const suffix = unit ? ` ${unit}` : "";
  if (Number(rounded) === 0) return `${(0).toFixed(digits)}${suffix}`;
  return `${value > 0 ? "+" : "−"}${rounded.replace("-", "")}${suffix}`;
}

/** A file size in the units people expect: 940 KB, 2.1 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1000)} KB`;
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

export function formatDate(value: string | Date): string {
  return dateFormat.format(typeof value === "string" ? parseDay(value) : value);
}

/** A month, YYYY-MM, as "Nov 2021". */
export function formatMonth(month: string): string {
  return monthFormat.format(parseDay(`${month.slice(0, 7)}-01`));
}

/** A day's month in running text: "2025-09-16" as "September 2025". */
export function formatLongMonth(day: string): string {
  return longMonthFormat.format(parseDay(day));
}

/** A UTC timestamp as "14:00 UTC", with its date unless that's today's (UTC). */
export function formatTime(value: string, now: Date = new Date()): string {
  const time = new Date(value);
  const clock = `${timeFormat.format(time)} UTC`;
  return formatDay(time) === formatDay(now) ? clock : `${dateFormat.format(time)}, ${clock}`;
}

const listFormat = new Intl.ListFormat("en-US", { type: "conjunction" });

/** "1, 20 and 50": a list in running text, without the serial comma the rest of the site doesn't use. */
export function formatList(items: (string | number)[]): string {
  return listFormat.format(items.map(String)).replace(/, and /, " and ");
}

const ordinalRules = new Intl.PluralRules("en-US", { type: "ordinal" });
const ordinalSuffixes: Record<string, string> = { one: "st", two: "nd", few: "rd", other: "th" };

/** 1st, 2nd, 3rd, 11th, 22nd. */
export function formatOrdinal(n: number): string {
  return `${n}${ordinalSuffixes[ordinalRules.select(n)]}`;
}

/** A share as a whole percentage: 0.684 as "68%". */
export function formatPercent(share: number): string {
  return `${Math.round(share * 100)}%`;
}
