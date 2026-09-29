import type { Agreement } from "../api/types";

/** Heatwave days at one depth and year, split by whether the satellite saw a heatwave too. */
export interface MissedYear {
  depth: number;
  year: number;
  missed: number; // a heatwave at depth, none in the satellite record
  seen: number; // a heatwave in both
}

/** The share of heatwave days at depth on which the satellite saw none; null when there were none. */
export function missedShare(rows: Agreement[]): number | null {
  let missed = 0;
  let seen = 0;
  for (const row of rows) {
    missed += row.buoy_only;
    seen += row.both;
  }
  return missed + seen > 0 ? missed / (missed + seen) : null;
}

/** Missed and seen heatwave days by depth and year, for one buoy or, without `buoy`, summed over every buoy. */
export function missedByYear(rows: Agreement[], buoy?: string): MissedYear[] {
  const totals = new Map<string, MissedYear>();
  for (const row of rows) {
    if (buoy !== undefined && row.buoy_id !== buoy) continue;
    const key = `${row.depth}-${row.year}`;
    const total = totals.get(key) ?? { depth: row.depth, year: row.year, missed: 0, seen: 0 };
    total.missed += row.buoy_only;
    total.seen += row.both;
    totals.set(key, total);
  }
  return [...totals.values()].sort((a, b) => a.depth - b.depth || a.year - b.year);
}
