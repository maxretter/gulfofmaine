import type { Condition } from "../api/types";
import { categories, colors } from "../lib/colors";
import { daysBetween } from "../lib/dates";
import { formatDate } from "../lib/format";
import { stateLook, type Variant } from "../lib/state";

export function Swatch({ color, variant = "dot" }: { color: string; variant?: Variant }) {
  const style =
    variant === "ring"
      ? { background: colors.surface, boxShadow: `inset 0 0 0 2px ${color}` }
      : variant === "hollow"
        ? { background: "transparent", boxShadow: `inset 0 0 0 1.5px ${color}` }
        : { background: color };
  return <span className={`swatch${variant === "square" ? " square" : ""}`} style={style} aria-hidden="true" />;
}

function label(condition: Condition): string {
  switch (condition.state) {
    case "heatwave": {
      const day = daysBetween(condition.event_start!, condition.date!) + 1;
      return `${condition.category_name} heatwave · day ${day}`;
    }
    case "above_threshold":
      return `Above threshold · ${condition.days_above} day${condition.days_above === 1 ? "" : "s"}`;
    case "normal":
      return "No heatwave";
    case "offline":
      return `No data since ${formatDate(condition.date!)}`;
    default:
      return "No data yet";
  }
}

/** Status is never colour alone: a shaped swatch plus a text label. */
export function StateBadge({ condition }: { condition: Condition }) {
  const look = stateLook(condition);
  const muted = condition.state === "offline" || condition.state === "no_data";
  return (
    <span className={`state${muted ? " muted" : ""}`}>
      <Swatch {...look} />
      {label(condition)}
    </span>
  );
}

export function StateLegend() {
  return (
    <div className="legend">
      {Object.entries(categories).map(([n, { name }]) => (
        <span className="state" key={n}>
          <Swatch {...stateLook({ state: "heatwave", category: Number(n) })} />
          {name}
        </span>
      ))}
      <span className="state">
        <Swatch {...stateLook({ state: "above_threshold", category: null })} />
        Above threshold
      </span>
      <span className="state">
        <Swatch {...stateLook({ state: "normal", category: null })} />
        No heatwave
      </span>
      <span className="state">
        <Swatch {...stateLook({ state: "offline", category: null })} />
        No recent data
      </span>
    </div>
  );
}
