import { useState } from "react";

import { isDay } from "../lib/dates";

interface Props {
  value: string; // ISO day
  min: string;
  max: string;
  onCommit: (day: string) => void;
}

interface Draft {
  text: string; // what the input holds
  own: string[]; // the value typing began over, and every day committed since: values it may show over
  latest: string; // the value the page will hold once those commits land
}

/**
 * A date input that holds what's being typed until it's a day between `min` and `max`, then commits it: typed a digit
 * at a time, a year passes through 0002 and 0020 on its way to 2021, and those shouldn't move the charts.
 *
 * A commit reaches `value` only when the router's transition renders, which can be a keystroke or two later. So the
 * draft stays in view while `value` is one it knows, its own commits landing, and gives way to any other, such as the
 * range brush's; and whether a day is new is judged against the latest commit, not the `value` still on its way.
 */
export function DateField({ value, min, max, onCommit }: Props) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const current = draft?.own.includes(value) ? draft : null;

  return (
    <input
      type="date"
      className="select date-input"
      value={current ? current.text : value}
      min={min}
      max={max}
      onChange={(event) => {
        const day = event.target.value;
        let { own, latest } = current ?? { own: [value], latest: value };
        if (isDay(day) && day >= min && day <= max && day !== latest) {
          onCommit(day);
          own = [...own, day];
          latest = day;
        }
        setDraft({ text: day, own, latest });
      }}
      // Leaving the field with an unfinished or out-of-range date puts back the one in use.
      onBlur={() => setDraft(null)}
    />
  );
}
