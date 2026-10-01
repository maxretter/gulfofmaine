// Words for a heatwave's origin and the evidence behind it (heatwaves/origin.py).
// Thresholds come from /api/origin/rules, so the page says what the code does.

import type { Buoy, Evidence, HeatwaveEvent, Origin, OriginRules, Signal, Vote } from "../api/types";
import { daysBetween } from "./dates";
import { formatDate, formatSigned } from "./format";

export const SIGNALS: { key: Signal; name: string }[] = [
  { key: "salinity", name: "Salinity at this depth" },
  { key: "surface_heatwave", name: "Heatwave at 1 m before" },
  { key: "stratification", name: "1 m minus this depth" },
  { key: "deep", name: "Deep water at M01" },
  { key: "onset_order", name: "Which buoys' heatwaves began first" },
];

export function countVotes(votes: Record<Signal, Vote>): { offshore: number; surface: number } {
  const values = Object.values(votes);
  return {
    offshore: values.filter((vote) => vote === "offshore").length,
    surface: values.filter((vote) => vote === "surface").length,
  };
}

/** One sentence on how the signals added up to the label. */
export function verdict(origin: Origin, votes: Record<Signal, Vote>, margin: number): string {
  const { offshore, surface } = countVotes(votes);
  const total = Object.keys(votes).length;
  if (offshore + surface === 0) return "None of the signals had the data to vote.";
  const tally = `${plural(offshore, "signal")} point${offshore === 1 ? "s" : ""} offshore and ${surface || "none"} to the surface`;
  if (origin === "unclear") return `${capitalize(tally)}: a label needs ${margin} more votes on one side.`;
  const leading = origin === "offshore" ? offshore : surface;
  const trailing = origin === "offshore" ? surface : offshore;
  return `${leading} of ${total} signals point ${origin === "offshore" ? "offshore" : "to the surface"}, and ${
    trailing || "none"
  } the other way.`;
}

/** What a signal measured for one heatwave, and the rule that turned it into a vote, or why it didn't vote. */
export function reading(signal: Signal, evidence: Evidence, rules: OriginRules, depth: number): string {
  const few = `fewer than ${rules.min_days} days`; // too few in a window to vote on
  switch (signal) {
    case "salinity": {
      const value = evidence.salinity_anomaly;
      if (value === null)
        return `${capitalize(few)} of salinity data at ${depth} m from ${rules.before} days before onset to ${rules.after} after, so it doesn't vote.`;
      const mean = `${formatSigned(value, "", 2)} against normal, on average from ${rules.before} days before onset to ${rules.after} after.`;
      const drift = formatSigned(rules.drift, "", 2);
      if (value < rules.drift) return `${mean} The rules leave out anything below ${drift}, so it doesn't vote.`;
      return `${mean} ${formatSigned(rules.salty, "", 2)} or more votes offshore; ${formatSigned(rules.fresh, "", 2)} down to ${drift} votes surface.`;
    }
    case "surface_heatwave": {
      const days = evidence.surface_heatwave_days;
      const none = `No heatwave at 1 m in the ${rules.before} days before onset`;
      if (days === null) return `${none}, but ${few} of data there, so it doesn't vote.`;
      if (days > 0) return `${plural(days, "day")} of heatwave at 1 m in the ${rules.before} days before onset, which votes surface.`;
      if (evidence.votes.surface_heatwave === "offshore") return `${none}, which votes offshore.`;
      // 1 m had enough days. No heatwave there votes offshore only with 1 m warmer than this depth by the rules'
      // margin, which takes enough days with data at both.
      if (evidence.stratification_before === null)
        return `${none}, but ${few} had data at both 1 m and ${depth} m to compare them, so it doesn't vote.`;
      return `${none}, but 1 m was less than ${formatSigned(rules.mixed)} warmer than ${depth} m, so it doesn't vote.`;
    }
    case "stratification": {
      const { stratification_before: before, stratification_after: after } = evidence;
      const tooFew = (window: string) => `${capitalize(few)} had data at both 1 m and ${depth} m ${window}`;
      const beforeOnset = `in the ${rules.before} days before onset`;
      const afterOnset = `from onset to ${rules.after} days after`;
      if (before === null && after === null) return `${tooFew(beforeOnset)}, and ${few} ${afterOnset}, so it doesn't vote.`;
      if (before === null) return `${tooFew(beforeOnset)}, so it doesn't vote.`;
      if (after === null) return `${tooFew(afterOnset)}, so it doesn't vote.`;
      const change = `1 m minus ${depth} m averaged ${formatSigned(before)} before onset and ${formatSigned(after)} after.`;
      if (before < rules.mixed) return `${change} It needs ${formatSigned(rules.mixed)} or more before onset to vote.`;
      return `${change} Falling below ${Math.round(rules.collapse * 100)}% of the value before votes surface; otherwise it votes offshore.`;
    }
    case "deep": {
      const days = evidence.deep_heatwave_days;
      const where = `M01 at ${rules.deep_depths[0]}–${rules.deep_depths.at(-1)} m`;
      if (days === null)
        return `${where} had no heatwave in the ${rules.before} days before onset, but no depth there had ${rules.min_days} days of data, so it doesn't vote.`;
      if (days > 0) return `${where} was in a heatwave on ${plural(days, "day")} of the ${rules.before} before onset, which votes offshore.`;
      return `${where} had no heatwave in the ${rules.before} days before onset, which votes surface.`;
    }
    case "onset_order": {
      const { offshore_onset: offshore, western_onset: western } = evidence;
      const east = rules.offshore_buoys.join(" or ");
      const west = rules.western_buoys.join(" or ");
      if (offshore && western) {
        const lag = daysBetween(offshore, western);
        const order =
          Math.abs(lag) <= rules.together
            ? `within ${plural(rules.together, "day")} of each other: together`
            : lag > 0
              ? `${east} first, by ${plural(lag, "day")}`
              : `${west} first, by ${plural(-lag, "day")}`;
        return `Heatwaves began at ${east} on ${formatDate(offshore)} and at ${west} on ${formatDate(western)}: ${order}.`;
      }
      // One side's heatwave alone votes only if the other side had the data to have had one too.
      const unseen = (buoys: string[]) =>
        `${buoys.join(" and ")} each had data on fewer than half the ${rules.lookback} days before this one, too few to vote.`;
      if (offshore) {
        const began = `A heatwave began at ${east} on ${formatDate(offshore)}`;
        if (evidence.votes.onset_order === null) return `${began}, but ${unseen(rules.western_buoys)}`;
        return `${began}, and none at ${west} in the ${rules.lookback} days before this one.`;
      }
      if (western) {
        const began = `A heatwave began at ${west} on ${formatDate(western)}`;
        if (evidence.votes.onset_order === null) return `${began}, but ${unseen(rules.offshore_buoys)}`;
        return `${began}, and none at ${east} in the ${rules.lookback} days before this one.`;
      }
      return `No heatwave began at ${east} or ${west} in the ${rules.lookback} days before this one.`;
    }
  }
}

export interface OriginYear {
  year: number;
  origin: Origin;
  count: number;
}

/** Heatwaves at one depth that began in each year, by origin; years without any are left out. */
export function originsByYear(events: HeatwaveEvent[], depth: number): OriginYear[] {
  const counts = new Map<string, OriginYear>();
  for (const event of events) {
    if (event.depth !== depth || event.origin === null) continue;
    const year = Number(event.start_date.slice(0, 4));
    const key = `${year}-${event.origin}`;
    const row = counts.get(key) ?? { year, origin: event.origin, count: 0 };
    row.count += 1;
    counts.set(key, row);
  }
  return [...counts.values()].sort((a, b) => a.year - b.year);
}

/** Buoys measuring `depth`, east to west. */
export function eastToWest(buoys: Buoy[], depth: number): Buoy[] {
  return buoys
    .filter((b) => b.longitude !== null && b.series.some((s) => s.depth === depth))
    .sort((a, b) => b.longitude! - a.longitude!);
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
