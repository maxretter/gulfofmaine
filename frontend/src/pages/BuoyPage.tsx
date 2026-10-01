import { useCallback, useMemo } from "react";
import { Link, useParams } from "react-router";

import { useBuoys, useEvents } from "../api/queries";
import type { Buoy, Condition, HeatwaveEvent } from "../api/types";
import { DateField } from "../components/DateField";
import { DepthCharts, SeriesLegend } from "../components/DepthCharts";
import { EventList } from "../components/EventList";
import { RangeBrush } from "../components/RangeBrush";
import { SatelliteMisses } from "../components/SatelliteMisses";
import { StateBadge } from "../components/StateBadge";
import { addDays, daysBetween, earliest, latest, maxDay, minDay, wholeYear, yearSpan } from "../lib/dates";
import { eventRange, eventsInRange } from "../lib/events";
import { formatDate, formatList, formatSigned, formatTemp, formatTime } from "../lib/format";
import { useBuoyView } from "../state/buoyView";

/** The requested period clamped to a buoy's record, falling back to its past year. */
function clampRange(requestedFrom: string | null, requestedTo: string | null, firstDate: string, lastDate: string) {
  let from = maxDay(requestedFrom ?? addDays(lastDate, -364), firstDate);
  let to = minDay(requestedTo ?? lastDate, lastDate);
  if (from >= to) [from, to] = [maxDay(addDays(lastDate, -364), firstDate), lastDate];
  return { from, to, firstDate, lastDate };
}

/** One buoy: its latest readings, its record over a chosen period, and the heatwaves in it. /buoys/F01?depth=20 */
export function BuoyPage() {
  const params = useParams();
  const id = (params.buoy ?? "").toUpperCase();
  const [view, update] = useBuoyView();
  const buoys = useBuoys();
  const events = useEvents();
  const setRange = useCallback((from: string, to: string) => update({ from, to }, { replace: true }), [update]);
  // Made again only when the heatwaves change: the charts redraw for a new list, and a redraw ends a drag on the record.
  const buoyEvents = useMemo(() => (events.data ?? []).filter((e) => e.buoy_id === id), [events.data, id]);

  if (buoys.isPending) return <p className="note">Loading…</p>;
  if (buoys.isError)
    return (
      <p className="note">
        Couldn't reach the API. <button onClick={() => buoys.refetch()}>Try again</button>
      </p>
    );

  const buoy = buoys.data.find((b) => b.id === id);
  if (!buoy) return <NotFoundBuoy />;

  const lastDate = latest(buoy.series.map((s) => s.date));
  const firstDate = earliest(buoy.series.map((s) => s.first_date));
  const range = lastDate && firstDate ? clampRange(view.from, view.to, firstDate, lastDate) : null;
  // The record strip follows the requested depth when this buoy has it, else its shallowest.
  const depth = buoy.series.find((s) => s.depth === view.depth)?.depth ?? buoy.series[0]?.depth ?? view.depth;

  return (
    <>
      <section className="intro">
        <p className="kicker">
          <Link to="/buoys">Buoys</Link>
          <span className="kicker-sep" aria-hidden="true">
            ·
          </span>
          {buoy.id}
        </p>
        <h1>{buoy.name}</h1>
        <p className="lead">
          Daily water temperature at {formatList(buoy.series.map((s) => s.depth))} m
          {firstDate && lastDate && `, recorded from ${formatDate(firstDate)} to ${formatDate(lastDate)}`}.
        </p>
      </section>

      <Tiles buoy={buoy} />

      <section className="card">
        {range ? (
          <Record
            buoy={buoy}
            events={buoyEvents}
            depth={depth}
            {...range}
            onDepth={(d) => update({ depth: d })}
            onRange={(from, to) => update({ from, to })}
            onBrush={setRange}
          />
        ) : (
          // A new buoy whose first sync hasn't found data yet.
          <p className="note">No data yet from this buoy.</p>
        )}
      </section>

      {buoy.satellite && (
        <section className="card">
          <h2>What the satellite misses here</h2>
          <p className="caption">
            Heatwave days at depth each year, by whether the satellite saw one at the surface.{" "}
            <Link to="/satellite">Across every buoy</Link>.
          </p>
          <SatelliteMisses buoy={buoy.id} />
        </section>
      )}
    </>
  );
}

function NotFoundBuoy() {
  return (
    <section className="intro">
      <h1>No such buoy</h1>
      <p className="lead">
        <Link to="/buoys">See every buoy</Link>
      </p>
    </section>
  );
}

/** The latest daily mean at each depth, with its status, and the satellite's at the surface when it has one. */
function Tiles({ buoy }: { buoy: Buoy }) {
  const satellite = buoy.satellite?.temperature != null ? buoy.satellite : null;
  // The tiles mostly share a day, so it goes by the heading; a tile names its own only when that differs.
  const day = latest(buoy.series.map((s) => s.date));
  return (
    <section className="latest" aria-labelledby="latest-title">
      <div className="detail-head">
        <h2 id="latest-title">Latest daily mean</h2>
        {day && <p className="range-label">{formatDate(day)}</p>}
      </div>
      <div className="tiles">
        {buoy.series.map((s) => (
          <Tile key={s.depth} label={`${s.depth} m`} condition={s} day={day} />
        ))}
        {satellite && <Tile label="Surface, by satellite" condition={satellite} day={day} />}
      </div>
    </section>
  );
}

function Tile({ label, condition, day }: { label: string; condition: Condition; day: string | null }) {
  // An offline series' badge already says when its data stopped.
  const ownDay = condition.date !== day && condition.state !== "offline" ? condition.date : null;
  return (
    <div className="tile">
      <p className="tile-label">{label}</p>
      <p className="tile-value">{formatTemp(condition.temperature)}</p>
      <p className="tile-line">
        <strong>{formatSigned(condition.anomaly)}</strong> vs normal
      </p>
      <p className="tile-state">
        <StateBadge condition={condition} />
      </p>
      {(ownDay || condition.reading_at) && (
        <div className="tile-foot">
          {ownDay && <p>Daily mean for {formatDate(ownDay)}</p>}
          {condition.reading_at && (
            <p>
              <span className="tile-foot-label">Hourly reading</span>
              {formatTemp(condition.reading)} at {formatTime(condition.reading_at)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface RecordProps {
  buoy: Buoy;
  events: HeatwaveEvent[]; // this buoy's, every depth
  depth: number; // of the record strip
  firstDate: string;
  lastDate: string;
  from: string;
  to: string;
  onDepth: (depth: number) => void;
  onRange: (from: string, to: string) => void; // a new entry in the browser history
  onBrush: (from: string, to: string) => void; // replaces the current one
}

/** The buoy's record over the chosen period at every depth, the strip to choose it on, and its heatwaves. */
function Record({ buoy, events, depth, firstDate, lastDate, from, to, onDepth, onRange, onBrush }: RecordProps) {
  const presets = [
    { label: "Past 12 months", from: addDays(lastDate, -364) },
    { label: "Past 5 years", from: addDays(lastDate, -5 * 365) },
    { label: "Full record", from: firstDate },
  ];
  const zoomTo = (event: HeatwaveEvent) => {
    const { from, to } = eventRange(event);
    onRange(from, to);
  };
  const lastYear = Number(lastDate.slice(0, 4));
  const years = Array.from({ length: lastYear - Number(firstDate.slice(0, 4)) + 1 }, (_, i) => lastYear - i);
  const year = wholeYear(from, to, firstDate, lastDate);
  const stripEvents = useMemo(() => events.filter((e) => e.depth === depth), [events, depth]);

  return (
    <>
      <div className="detail-head">
        <h2>Record</h2>
        <p className="range-label">
          {formatDate(from)} – {formatDate(to)} · {daysBetween(from, to) + 1} days
        </p>
      </div>

      <div className="range-controls">
        <div className="presets" role="group" aria-label="Period">
          {presets.map((preset) => {
            const start = maxDay(preset.from, firstDate);
            return (
              <button
                key={preset.label}
                type="button"
                aria-pressed={from === start && to === lastDate}
                onClick={() => onRange(start, lastDate)}
              >
                {preset.label}
              </button>
            );
          })}
        </div>
        <label className="field">
          <span className="filter-label">Year</span>
          <select
            className="select"
            value={year ?? ""}
            onChange={(e) => {
              const span = yearSpan(Number(e.target.value), firstDate, lastDate);
              onRange(span.from, span.to);
            }}
          >
            {year === null && <option value="">–</option>}
            {years.map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
        </label>
        <div className="field-group" role="group" aria-label="Dates">
          <label className="field">
            <span className="filter-label">From</span>
            <DateField value={from} min={firstDate} max={addDays(to, -1)} onCommit={(day) => onRange(day, to)} />
          </label>
          <label className="field">
            <span className="filter-label">To</span>
            <DateField value={to} min={addDays(from, 1)} max={lastDate} onCommit={(day) => onRange(from, day)} />
          </label>
        </div>
      </div>

      <div className="range-head">
        <p className="caption">
          Drag across the record to choose a period.
        </p>
        {buoy.series.length > 1 && (
          <div className="filters" role="group" aria-label="Depth of the record strip">
            <span className="filter-label">Strip at</span>
            <div className="segmented">
              {buoy.series.map((s) => (
                <button key={s.depth} type="button" aria-pressed={s.depth === depth} onClick={() => onDepth(s.depth)}>
                  {s.depth} m
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <RangeBrush
        buoy={buoy.id}
        depth={depth}
        firstDate={firstDate}
        lastDate={lastDate}
        from={from}
        to={to}
        events={stripEvents}
        onChange={onBrush}
      />
      <SeriesLegend buoy={buoy} />
      <DepthCharts buoy={buoy} from={from} to={to} events={events} />

      <h3>Heatwaves in this period</h3>
      <EventList
        events={eventsInRange(events, buoy.id, from, to).sort((a, b) => a.start_date.localeCompare(b.start_date))}
        onZoom={zoomTo}
      />
      <p className="sources">
        Data:{" "}
        {buoy.series.map((s, i) => (
          <span key={s.depth}>
            {i > 0 && " · "}
            <a href={s.erddap_url}>{s.dataset_id}</a>
          </span>
        ))}
        {buoy.satellite && (
          <>
            {" · "}
            <a href={buoy.satellite.erddap_url}>NOAA OISST</a> (satellite)
          </>
        )}
      </p>
    </>
  );
}
