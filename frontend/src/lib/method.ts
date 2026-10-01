import type { Method } from "../api/types";

// The pages state the method in words: they take its numbers from /api/method (useMethod), so as not to drift
// from the code that applies them.

const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
  "twenty",
];

/** A count as running text has it: in words up to twenty ("five"), in figures beyond. */
export function inWords(count: number): string {
  return WORDS[count] ?? String(count);
}

/** The baseline's years, "2003–2022". */
export function baselineYears(method: Pick<Method, "baseline_start" | "baseline_end">): string {
  return `${method.baseline_start}–${method.baseline_end}`;
}

/** How many years the baseline spans, both ends included. */
export function baselineLength(method: Pick<Method, "baseline_start" | "baseline_end">): number {
  return method.baseline_end - method.baseline_start + 1;
}

/** "Moderate (1×), Strong (2×), …, Extreme (4× or more)": each category by the multiples it takes. */
export function categoryScale(method: Pick<Method, "categories">): string {
  const last = method.categories.length;
  return method.categories.map((name, i) => `${name} (${i + 1}×${i + 1 === last ? " or more" : ""})`).join(", ");
}

/** The hour of the day, UTC, by which a day can have `min_hours` hours with a reading: "18:00 UTC". */
export function dayCountsFrom(method: Pick<Method, "min_hours">): string {
  return `${String(method.min_hours).padStart(2, "0")}:00 UTC`;
}
