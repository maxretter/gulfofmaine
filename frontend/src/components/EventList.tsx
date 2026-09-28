import type { HeatwaveEvent } from "../api/types";
import { categories } from "../lib/colors";
import { formatDate, formatSigned } from "../lib/format";
import { Swatch } from "./StateBadge";

interface Props {
  events: HeatwaveEvent[];
  onZoom: (event: HeatwaveEvent) => void;
}

/** A compact list of heatwaves; each one zooms the charts to itself. */
export function EventList({ events, onZoom }: Props) {
  if (!events.length) return <p className="caption">No heatwaves in this period.</p>;
  return (
    <ul className="event-list">
      {events.map((event) => (
        <li key={`${event.depth}-${event.start_date}`}>
          <button type="button" onClick={() => onZoom(event)}>
            <span className="state">
              <Swatch color={categories[event.category].color} />
              {event.category_name}
            </span>
            <span>{event.depth} m</span>
            <span>
              {formatDate(event.start_date)} – {formatDate(event.end_date)}
            </span>
            <span className="num">{event.duration} days</span>
            <span className="num">peak {formatSigned(event.max_intensity)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
