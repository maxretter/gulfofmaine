import { useState } from "react";
import { Link, useNavigate } from "react-router";

import type { Buoy, HeatwaveEvent } from "../api/types";
import { categories } from "../lib/colors";
import { eventPath, overlapping, rankAmong } from "../lib/events";
import { formatDate, formatOrdinal, formatSigned } from "../lib/format";
import { CategoryLabel, OriginLabel } from "./Label";
import { Swatch } from "./StateBadge";

type RankKey = Parameters<typeof rankAmong>[2];

const SHOWN = 8; // overlapping heatwaves listed before "Show all"

/** "The longest of B01's 57 heatwaves at 1 m", "3rd highest of …", or "B01's only heatwave at 150 m". */
function rankLine(events: HeatwaveEvent[], event: HeatwaveEvent, key: RankKey, superlative: string): string {
  const { rank, of } = rankAmong(events, event, key);
  const among = `${event.buoy_id}'s ${of} heatwaves at ${event.depth} m`;
  if (of === 1) return `${event.buoy_id}'s only heatwave at ${event.depth} m`;
  return rank === 1 ? `The ${superlative} of ${among}` : `${formatOrdinal(rank)} ${superlative} of ${among}`;
}

/** How far the peak rose, in multiples of the gap between normal and the threshold: what sets the category. */
function multiple(category: number): string {
  return category === 4 ? "4× or more" : `${category}–${category + 1}×`;
}

/** The heatwave in four figures, each against the others at its buoy and depth. `events` is every heatwave, if loaded. */
export function EventFigures({ event, events }: { event: HeatwaveEvent; events: HeatwaveEvent[] | undefined }) {
  const rank = (key: RankKey, superlative: string) =>
    events && <div className="tile-foot">{rankLine(events, event, key, superlative)}</div>;
  return (
    <div className="tiles figures">
      <div className="tile">
        <p className="tile-label">Length</p>
        <p className="tile-value">{event.duration} days</p>
        <p className="tile-line">
          {formatDate(event.start_date)} to {formatDate(event.end_date)}
        </p>
        {rank("duration", "longest")}
      </div>
      <div className="tile">
        <p className="tile-label">Peak</p>
        <p className="tile-value">{formatSigned(event.max_intensity)}</p>
        <p className="tile-line">above normal on {formatDate(event.peak_date)}</p>
        {rank("max_intensity", "highest")}
      </div>
      <div className="tile">
        <p className="tile-label">Mean</p>
        <p className="tile-value">{formatSigned(event.mean_intensity)}</p>
        <p className="tile-line">above normal on average</p>
        {rank("mean_intensity", "highest")}
      </div>
      <div className="tile">
        <p className="tile-label">Category</p>
        <p className="tile-value">
          <Swatch color={categories[event.category].color} variant="square" />
          {event.category_name}
        </p>
        <p className="tile-line">
          Rose to {multiple(event.category)} the gap between normal and the heatwave threshold
        </p>
        <div className="tile-foot">
          <Link to="/about#heatwaves">How heatwaves are categorized</Link>
        </div>
      </div>
    </div>
  );
}

/** Every other heatwave that overlapped this one, at its buoy's other depths and at the other buoys. */
export function AtTheSameTime({ event, events, buoys }: { event: HeatwaveEvent; events: HeatwaveEvent[]; buoys: Buoy[] }) {
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  const others = overlapping(events, event);
  const here = others.filter((e) => e.buoy_id === event.buoy_id).length;
  const names = new Map(buoys.map((b) => [b.id, b.name]));
  const count = (n: number) => `${n} heatwave${n === 1 ? "" : "s"}`;

  return (
    <section className="card">
      <h2>At the same time</h2>
      {others.length === 0 ? (
        <p className="note">No other heatwave overlapped this one, at {event.buoy_id} or at any other buoy.</p>
      ) : (
        <>
          <p className="caption">
            {count(others.length)} overlapped this one: {here} at {event.buoy_id}'s other depths and{" "}
            {others.length - here} at other buoys.
          </p>
          <div className="table-scroll">
            <table className="events">
              <thead>
                <tr>
                  <th scope="col">Buoy</th>
                  <th scope="col">Depth</th>
                  <th scope="col">Start</th>
                  <th scope="col">End</th>
                  <th scope="col" className="num">
                    Days
                  </th>
                  <th scope="col" className="num">
                    Peak
                  </th>
                  <th scope="col">Category</th>
                  <th scope="col">Origin</th>
                </tr>
              </thead>
              <tbody>
                {(all ? others : others.slice(0, SHOWN)).map((other) => {
                  const href = eventPath(other);
                  return (
                    <tr
                      key={`${other.buoy_id}-${other.depth}-${other.start_date}`}
                      className="selectable"
                      onClick={() => navigate(href)}
                    >
                      <th scope="row">
                        <Link to={href} className="row-link" onClick={(e) => e.stopPropagation()}>
                          <span className="code">{other.buoy_id}</span>
                          <span className="buoy-name">{names.get(other.buoy_id)}</span>
                        </Link>
                      </th>
                      <td>{other.depth} m</td>
                      <td>{formatDate(other.start_date)}</td>
                      <td>{formatDate(other.end_date)}</td>
                      <td className="num">{other.duration}</td>
                      <td className="num">{formatSigned(other.max_intensity)}</td>
                      <td>
                        <CategoryLabel category={other.category} />
                      </td>
                      <td>
                        {other.origin ? <OriginLabel origin={other.origin} /> : <span className="muted">–</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {!all && others.length > SHOWN && (
            <button type="button" className="link-button" onClick={() => setAll(true)}>
              Show all {others.length}
            </button>
          )}
        </>
      )}
    </section>
  );
}
