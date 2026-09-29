import { formatDay, parseDay } from "./dates";

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

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

export function formatDate(value: string | Date): string {
  return dateFormat.format(typeof value === "string" ? parseDay(value) : value);
}

/** A UTC timestamp as "14:00 UTC", with its date unless that's today's (UTC). */
export function formatTime(value: string, now: Date = new Date()): string {
  const time = new Date(value);
  const clock = `${timeFormat.format(time)} UTC`;
  return formatDay(time) === formatDay(now) ? clock : `${dateFormat.format(time)}, ${clock}`;
}
