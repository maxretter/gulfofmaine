import { useCallback } from "react";
import { Link, useParams } from "react-router";

import { useBuoys, useEvents } from "../api/queries";
import type { Buoy, HeatwaveEvent } from "../api/types";
import { DepthCharts } from "../components/DepthCharts";
import { EventList } from "../components/EventList";
import { RangeBrush } from "../components/RangeBrush";
import { SatelliteMisses } from "../components/SatelliteMisses";
import { StateBadge, Swatch } from "../components/StateBadge";
import { categories, colors } from "../lib/colors";
import { addDays, daysBetween, earliest, latest, maxDay, minDay } from "../lib/dates";
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
  const buoyEvents = (events.data ?? []).filter((e) => e.buoy_id === buoy.id);
  // The record strip follows the requested depth when this buoy has it, else its shallowest.
  const depth = buoy.series.find((s) => s.depth === view.depth)?.depth ?? buoy.series[0]?.depth ?? view.depth;

  return (
    <>
      <section className="intro">
        <p className="crumbs">
          <Link to="/buoys">All buoys</Link>
        </p>
        <h1>
          <span className="code">{buoy.id}</span> {buoy.name}
        </h1>
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
            Heatwave days at 20 and 50 m each year, split by whether the satellite record also showed a heatwave at the
            surface above. Only days with data from both count. <Link to="/satellite">Across every buoy</Link>.
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
  return (
    <section className="latest" aria-labelledby="latest-title">
      <h2 id="latest-title">Latest daily mean</h2>
      <div className="tiles">
        {buoy.series.map((s) => (
          <div className="tile" key={s.depth}>
            <p className="tile-label">{s.depth} m</p>
            <p className="tile-value">{formatTemp(s.temperature)}</p>
            <p className="tile-delta">
              {formatSigned(s.anomaly)} vs normal{s.date && ` · ${formatDate(s.date)}`}
            </p>
            <p className="tile-state">
              <StateBadge condition={s} />
            </p>
            {s.reading_at && (
              <p className="tile-reading">
                Hourly reading {formatTemp(s.reading)} at {formatTime(s.reading_at)}
              </p>
            )}
          </div>
        ))}
        {satellite && (
          <div className="tile">
            <p className="tile-label">Surface, by satellite</p>
            <p className="tile-value">{formatTemp(satellite.temperature)}</p>
            <p className="tile-delta">
              {formatSigned(satellite.anomaly)} vs normal{satellite.date && ` · ${formatDate(satellite.date)}`}
            </p>
            <p className="tile-state">
              <StateBadge condition={satellite} />
            </p>
          </div>
        )}
      </div>
    </section>
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

  return (
    <>
      <div className="detail-head">
        <h2>Record</h2>
        <p className="range-label">
          {formatDate(from)} – {formatDate(to)} · {daysBetween(from, to) + 1} days
        </p>
      </div>

      <div className="range-head">
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
        events={events.filter((e) => e.depth === depth)}
        onChange={onBrush}
      />
      <p className="caption">
        The whole record at {depth} m, with its heatwaves shaded. Drag across it to choose a period.
      </p>

      <div className="legend series-legend">
        <span className="key">
          <span className="line" style={{ borderColor: colors.observed }} aria-hidden="true" />
          Daily mean
        </span>
        <span className="key">
          <span className="line" style={{ borderColor: colors.muted }} aria-hidden="true" />
          Normal
        </span>
        <span className="key">
          <span className="line dashed" style={{ borderColor: colors.ink2 }} aria-hidden="true" />
          Heatwave threshold (90th percentile)
        </span>
        {buoy.satellite?.first_date && (
          <span className="key">
            <svg width="18" height="4" aria-hidden="true">
              <line x1="0" x2="18" y1="2" y2="2" stroke={colors.satellite} strokeWidth="2" strokeDasharray="6,4" />
            </svg>
            Satellite, at the surface (top chart)
          </span>
        )}
        {Object.entries(categories).map(([n, c]) => (
          <span className="state" key={n}>
            <Swatch color={c.color} variant="square" />
            {c.name}
          </span>
        ))}
      </div>
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
