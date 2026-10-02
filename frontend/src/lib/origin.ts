// Words for a heatwave's origin and the evidence behind it (heatwaves/origin.py). Why each signal voted as it did
// comes from the API, and thresholds from /api/origin/rules, so the page says what the code does.

import type { Buoy, Evidence, HeatwaveEvent, Origin, OriginRules, Reasons, Signal, Vote } from "../api/types";
import { daysBetween } from "./dates";
import { formatDate, formatSigned } from "./format";

/** The five signals, each with its name: the deep water's buoy as the rules have it. */
export function signals(rules: Pick<OriginRules, "deep_buoy">): { key: Signal; name: string }[] {
  return [
    { key: "salinity", name: "Salinity at this depth" },
    { key: "surface_heatwave", name: "Heatwave at 1 m before" },
    { key: "stratification", name: "1 m minus this depth" },
    { key: "deep", name: `Deep water at ${rules.deep_buoy}` },
    { key: "onset_order", name: "Which buoys' heatwaves began first" },
  ];
}

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

/**
 * What a signal measured, and the rule that turned it into a vote, or why it didn't vote: its reason, which the API
 * reads from the evidence by the rules the vote was cast with (origin.explain), in words.
 */
export function reading(signal: Signal, evidence: Evidence, reasons: Reasons, rules: OriginRules, depth: number): string {
  const reason = reasons.signals[signal];
  const few = `fewer than ${rules.min_days} days`; // too few in a window to vote on
  switch (signal) {
    case "salinity": {
      if (reason === "too_few_days")
        return `${capitalize(few)} of salinity data at ${depth} m from ${rules.before} days before onset to ${rules.after} after, so it doesn't vote.`;
      const mean = `${formatSigned(evidence.salinity_anomaly, "", 2)} against normal, on average from ${rules.before} days before onset to ${rules.after} after.`;
      const drift = formatSigned(rules.drift, "", 2);
      if (reason === "drift") return `${mean} The rules leave out anything below ${drift}, so it doesn't vote.`;
      // Salty, fresh, or between the two: the rule says which.
      return `${mean} ${formatSigned(rules.salty, "", 2)} or more votes offshore; ${formatSigned(rules.fresh, "", 2)} down to ${drift} votes surface.`;
    }
    case "surface_heatwave": {
      const none = `No heatwave at 1 m in the ${rules.before} days before onset`;
      if (reason === "too_few_days") return `${none}, but ${few} of data there, so it doesn't vote.`;
      if (reason === "heatwave")
        return `${plural(evidence.surface_heatwave_days!, "day")} of heatwave at 1 m in the ${rules.before} days before onset, which votes surface.`;
      if (reason === "stratified") return `${none}, which votes offshore.`;
      // 1 m had enough days. No heatwave there votes offshore only with 1 m warmer than this depth by the rules'
      // margin, which takes enough days with data at both.
      if (reason === "too_few_days_to_compare")
        return `${none}, but ${few} had data at both 1 m and ${depth} m to compare them, so it doesn't vote.`;
      return `${none}, but 1 m was less than ${formatSigned(rules.mixed)} warmer than ${depth} m, so it doesn't vote.`;
    }
    case "stratification": {
      const tooFew = (window: string) => `${capitalize(few)} had data at both 1 m and ${depth} m ${window}`;
      const beforeOnset = `in the ${rules.before} days before onset`;
      const afterOnset = `from onset to ${rules.after} days after`;
      if (reason === "too_few_days") return `${tooFew(beforeOnset)}, and ${few} ${afterOnset}, so it doesn't vote.`;
      if (reason === "too_few_days_before") return `${tooFew(beforeOnset)}, so it doesn't vote.`;
      if (reason === "too_few_days_after") return `${tooFew(afterOnset)}, so it doesn't vote.`;
      const { stratification_before: before, stratification_after: after } = evidence;
      const change = `1 m minus ${depth} m averaged ${formatSigned(before)} before onset and ${formatSigned(after)} after.`;
      if (reason === "mixed") return `${change} It needs ${formatSigned(rules.mixed)} or more before onset to vote.`;
      // Collapsed or held.
      return `${change} Falling below ${Math.round(rules.collapse * 100)}% of the value before votes surface; otherwise it votes offshore.`;
    }
    case "deep": {
      const where = `${rules.deep_buoy} at ${rules.deep_depths[0]}–${rules.deep_depths.at(-1)} m`;
      if (reason === "too_few_days")
        return `${where} had no heatwave in the ${rules.before} days before onset, but no depth there had ${rules.min_days} days of data, so it doesn't vote.`;
      if (reason === "heatwave")
        return `${where} was in a heatwave on ${plural(evidence.deep_heatwave_days!, "day")} of the ${rules.before} before onset, which votes offshore.`;
      return `${where} had no heatwave in the ${rules.before} days before onset, which votes surface.`;
    }
    case "onset_order": {
      const { offshore_onset: offshore, western_onset: western } = evidence;
      const east = anyOf(reasons.offshore_buoys);
      const west = anyOf(reasons.western_buoys);
      // A heatwave at one of the four is compared without its own buoy, so no onset there counts, its own included.
      const own = reasons.left_out ? ` Onsets at ${reasons.left_out}, this heatwave's own buoy, don't count.` : "";
      if (reason === "together" || reason === "offshore_first" || reason === "western_first") {
        const lag = daysBetween(offshore!, western!);
        const order =
          reason === "together"
            ? `within ${plural(rules.together, "day")} of each other: together`
            : reason === "offshore_first"
              ? `${east} first, by ${plural(lag, "day")}`
              : `${west} first, by ${plural(-lag, "day")}`;
        return `Heatwaves began at ${east} on ${formatDate(offshore!)} and at ${west} on ${formatDate(western!)}: ${order}.${own}`;
      }
      // One side's heatwave alone votes only if the other side, without this heatwave's buoy, had the data to have had
      // one too.
      const unseen = (buoys: string[]) => {
        const had = buoys.length === 1 ? `${buoys[0]} had` : `${buoys.join(" and ")} each had`;
        return `${had} data on fewer than half the ${rules.lookback} days before this one, counting its onset day, too few to vote.`;
      };
      if (reason === "offshore_only" || reason === "western_unobserved") {
        const began = `A heatwave began at ${east} on ${formatDate(offshore!)}`;
        if (reason === "western_unobserved") return `${began}, but ${unseen(reasons.western_buoys)}${own}`;
        return `${began}, and none at ${west} on this one's onset day or in the ${rules.lookback} days before.${own}`;
      }
      if (reason === "western_only" || reason === "offshore_unobserved") {
        const began = `A heatwave began at ${west} on ${formatDate(western!)}`;
        if (reason === "offshore_unobserved") return `${began}, but ${unseen(reasons.offshore_buoys)}${own}`;
        return `${began}, and none at ${east} on this one's onset day or in the ${rules.lookback} days before.${own}`;
      }
      return `No heatwave began at ${anyOf([...reasons.offshore_buoys, ...reasons.western_buoys])} on this one's onset day or in the ${rules.lookback} days before, so it doesn't vote.${own}`;
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

/** "N01 or M01", "N01, A01 or B01". */
function anyOf(items: string[]): string {
  return items.length > 1 ? `${items.slice(0, -1).join(", ")} or ${items.at(-1)}` : (items[0] ?? "");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
