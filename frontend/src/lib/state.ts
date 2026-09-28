import type { Condition } from "../api/types";
import { categories, colors } from "./colors";

export type Variant = "dot" | "square" | "ring" | "hollow";

/** How a state is drawn: shared by the badge, the legend and the map markers. */
export function stateLook(condition: Pick<Condition, "state" | "category">): { color: string; variant: Variant } {
  switch (condition.state) {
    case "heatwave":
      return { color: categories[condition.category ?? 1].color, variant: "dot" };
    case "above_threshold":
      return { color: categories[1].color, variant: "ring" };
    case "normal":
      return { color: colors.muted, variant: "dot" };
    default:
      return { color: colors.axis, variant: "hollow" };
  }
}
