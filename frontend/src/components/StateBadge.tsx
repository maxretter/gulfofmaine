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

function label(condition: Condition, depth?: number): string {
  switch (condition.state) {
    case "heatwave": {
      const day = daysBetween(condition.event_start!, condition.date!) + 1;
      return `${condition.category_name} heatwave · day ${day}`;
    }
    case "paused":
      return `${condition.category_name} heatwave · paused`;
    case "above_threshold":
      return `Above threshold · ${condition.days_above} day${condition.days_above === 1 ? "" : "s"}`;
    case "normal":
      return "No heatwave";
    case "no_normal":
      return "No normal";
    case "offline":
      return `No data${depth === undefined ? "" : ` at ${depth} m`} since ${formatDate(condition.date!)}`;
    default:
      return "No data yet";
  }
}

/**
 * Status is never color alone: a shaped swatch plus a text label. `depth`, where the badge stands apart from its
 * depth (a table of buoys at one depth), names it in "No data at 1 m since …", which isn't the whole buoy's date.
 */
export function StateBadge({ condition, depth }: { condition: Condition; depth?: number }) {
  const look = stateLook(condition);
  const muted = condition.state === "offline" || condition.state === "no_data" || condition.state === "no_normal";
  return (
    <span className={`state${muted ? " muted" : ""}`}>
      <Swatch {...look} />
      {label(condition, depth)}
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
        <Swatch {...stateLook({ state: "paused", category: 1 })} />
        Heatwave paused
      </span>
      <span className="state">
        <Swatch {...stateLook({ state: "above_threshold", category: null })} />
        Above threshold
      </span>
      <span className="state">
        <Swatch {...stateLook({ state: "normal", category: null })} />
        No heatwave
      </span>
      <span className="state">
        <Swatch {...stateLook({ state: "no_normal", category: null })} />
        No normal
      </span>
      <span className="state">
        <Swatch {...stateLook({ state: "offline", category: null })} />
        No recent data
      </span>
    </div>
  );
}
