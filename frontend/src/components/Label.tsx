import type { ReactNode } from "react";

import type { Origin, Vote } from "../api/types";
import { categories, colors, origins } from "../lib/colors";
import type { Variant } from "../lib/state";
import { Swatch } from "./StateBadge";

/** A swatch with its words: how categories and origins appear everywhere, never as color alone. */
export function Label({ color, variant, children }: { color: string; variant?: Variant; children: ReactNode }) {
  return (
    <span className="state">
      <Swatch color={color} variant={variant} />
      {children}
    </span>
  );
}

export function CategoryLabel({ category }: { category: number }) {
  const { name, color } = categories[category];
  return <Label color={color}>{name}</Label>;
}

export function OriginLabel({ origin }: { origin: Origin }) {
  const { name, color } = origins[origin];
  return (
    <Label color={color} variant={origin === "unclear" ? "hollow" : "square"}>
      {name}
    </Label>
  );
}

/** How one signal voted on a heatwave's origin. */
export function VoteLabel({ vote }: { vote: Vote }) {
  if (vote) return <OriginLabel origin={vote} />;
  return (
    <span className="state muted">
      <Swatch color={colors.axis} variant="hollow" />
      No vote
    </span>
  );
}
