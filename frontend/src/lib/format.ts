import { parseDay } from "./dates";

const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
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
