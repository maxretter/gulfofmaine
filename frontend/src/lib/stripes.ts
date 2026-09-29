// The stripes across the header: the Gulf's temperature against normal, a month to a stripe.

import type { MonthAnomaly } from "../api/types";

/** The depth the stripes show: below the surface, where the site's story is. */
export const STRIPES_DEPTH = 50;

export interface Stripe {
  month: string; // YYYY-MM
  anomaly: number | null; // null for a month no buoy counts toward
}

/** Every month from the first to the last in `rows`, in order, with a gap left null so time stays even. */
export function stripes(rows: MonthAnomaly[]): Stripe[] {
  if (!rows.length) return [];
  const known = new Map(rows.map((row) => [row.month.slice(0, 7), row.anomaly]));
  const months = [...known.keys()].sort();
  const [first, last] = [months[0], months[months.length - 1]];
  const all: Stripe[] = [];
  for (let year = Number(first.slice(0, 4)), month = Number(first.slice(5, 7)); ; month++) {
    if (month > 12) [year, month] = [year + 1, 1];
    const key = `${year}-${String(month).padStart(2, "0")}`;
    all.push({ month: key, anomaly: known.get(key) ?? null });
    if (key === last) return all;
  }
}

/** The warmest month among `stripes`, or null if none has a value. */
export function warmest(stripes: Stripe[]): Stripe | null {
  return stripes.reduce<Stripe | null>(
    (best, s) => (s.anomaly !== null && (best === null || s.anomaly > best.anomaly!) ? s : best),
    null,
  );
}
