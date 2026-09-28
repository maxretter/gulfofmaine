const dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC",
});

export function formatTemp(value: number | null | undefined): string {
  return value == null ? "–" : `${value.toFixed(1)} °C`;
}

/** Signed, with a true minus sign; values that round to zero get no sign. */
export function formatSigned(value: number | null | undefined): string {
  if (value == null) return "–";
  const rounded = value.toFixed(1);
  if (Number(rounded) === 0) return "0.0 °C";
  return `${value > 0 ? "+" : "−"}${rounded.replace("-", "")} °C`;
}

export function formatDate(value: string | Date): string {
  return dateFormat.format(typeof value === "string" ? new Date(`${value}T00:00:00Z`) : value);
}
