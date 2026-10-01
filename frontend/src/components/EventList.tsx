import { Link } from "react-router";

import type { HeatwaveEvent } from "../api/types";
import { eventPath } from "../lib/events";
import { formatDate, formatSigned } from "../lib/format";
import { CategoryLabel, OriginLabel } from "./Label";

interface Props {
  events: HeatwaveEvent[];
  onZoom: (event: HeatwaveEvent) => void;
}

/** A compact list of heatwaves; each one zooms the charts to itself, or opens its own page. */
export function EventList({ events, onZoom }: Props) {
  if (!events.length) return <p className="caption">No heatwaves in this period.</p>;
  return (
    <ul className="event-list">
      {events.map((event) => (
        <li key={`${event.depth}-${event.start_date}`}>
          <button type="button" onClick={() => onZoom(event)}>
            <CategoryLabel category={event.category} />
            <span>{event.depth} m</span>
            <span>
              {formatDate(event.start_date)} – {formatDate(event.end_date)}
            </span>
            <span className="num">{event.duration} days</span>
            <span className="num">peak {formatSigned(event.max_intensity)}</span>
          </button>
          {/* The origin label in a slot of its own, so each row's link lines up and always looks like one. */}
          <span className="event-origin">{event.origin && <OriginLabel origin={event.origin} />}</span>
          <Link to={eventPath(event)} className="event-details">
            Details
          </Link>
        </li>
      ))}
    </ul>
  );
}
