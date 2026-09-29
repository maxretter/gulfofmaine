// Days are handled as UTC midnights, matching the API's UTC daily means.

const DAY_MS = 86_400_000;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function parseDay(value: string): Date {
  return new Date(`${value}T00:00:00Z`);
}

export function formatDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function isDay(value: string | null): value is string {
  return value !== null && ISO_DAY.test(value) && formatDay(parseDay(value)) === value;
}

export function addDays(value: string, days: number): string {
  return formatDay(new Date(parseDay(value).getTime() + days * DAY_MS));
}

/** Whole days from `from` to `to`; 0 when they are the same day. */
export function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / DAY_MS);
}

export function minDay(a: string, b: string): string {
  return a < b ? a : b;
}

export function maxDay(a: string, b: string): string {
  return a > b ? a : b;
}

/** The latest of some ISO days or UTC timestamps, skipping missing ones; null if there are none. */
export function latest(values: (string | null | undefined)[]): string | null {
  return values.reduce<string | null>((found, value) => (value && (!found || value > found) ? value : found), null);
}

/** The earliest of some ISO days or UTC timestamps, skipping missing ones; null if there are none. */
export function earliest(values: (string | null | undefined)[]): string | null {
  return values.reduce<string | null>((found, value) => (value && (!found || value < found) ? value : found), null);
}
