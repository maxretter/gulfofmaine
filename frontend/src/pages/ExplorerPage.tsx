import { useCallback, useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { useAgreement, useBuoys, useEvents } from "../api/queries";
import type { Buoy, HeatwaveEvent } from "../api/types";
import { AnnualHeatmap } from "../components/AnnualHeatmap";
import { BuoyMap } from "../components/BuoyMap";
import { ConditionsTable } from "../components/ConditionsTable";
import { DepthCharts } from "../components/DepthCharts";
import { EventList } from "../components/EventList";
import { RangeBrush } from "../components/RangeBrush";
import { SatelliteMisses } from "../components/SatelliteMisses";
import { StateBadge, StateLegend, Swatch } from "../components/StateBadge";
import { missedShare } from "../lib/agreement";
import { categories, colors } from "../lib/colors";
import { addDays, daysBetween, earliest, latest, maxDay, minDay } from "../lib/dates";
import { eventRange, eventsInRange } from "../lib/events";
import { formatDate, formatSigned, formatTemp, formatTime } from "../lib/format";
import { DEPTHS, useExplorerState } from "../state/explorer";

/** The requested period clamped to a buoy's record, falling back to its past year. */
function clampRange(requestedFrom: string | null, requestedTo: string | null, firstDate: string, lastDate: string) {
  let from = maxDay(requestedFrom ?? addDays(lastDate, -364), firstDate);
  let to = minDay(requestedTo ?? lastDate, lastDate);
  if (from >= to) [from, to] = [maxDay(addDays(lastDate, -364), firstDate), lastDate];
  return { from, to, firstDate, lastDate };
}

/** Defaults to the first buoy in a heatwave at the chosen depth, so the first view is the interesting one. */
function pickBuoy(buoys: Buoy[], requested: string | null, depth: number): Buoy {
  return (
    buoys.find((b) => b.id === requested) ??
    buoys.find((b) => b.series.some((s) => s.depth === depth && s.state === "heatwave")) ??
    buoys[0]
  );
}

export function ExplorerPage() {
  const [state, update] = useExplorerState();
  const buoys = useBuoys();
  const events = useEvents();
  const detail = useRef<HTMLElement>(null);

  const selectYear = useCallback(
    (buoy: string, year: number) => {
      update({ buoy, from: `${year}-01-01`, to: `${year}-12-31` });
      detail.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    },
    [update],
  );
  const setRange = useCallback((from: string, to: string) => update({ from, to }, { replace: true }), [update]);

  // Links into the detail panel (/?buoy=...#detail) can only scroll once it has rendered.
  const location = useLocation();
  const scrolledFor = useRef<string | null>(null);
  useEffect(() => {
    if (location.hash !== "#detail" || !buoys.data || scrolledFor.current === location.key) return;
    scrolledFor.current = location.key;
    detail.current?.scrollIntoView({ block: "start" });
  }, [location.hash, location.key, buoys.data]);

  if (buoys.isPending) return <p className="note">Loading…</p>;
  if (buoys.isError)
    return (
      <p className="note">
        Couldn't reach the API. <button onClick={() => buoys.refetch()}>Try again</button>
      </p>
    );

  const buoy = pickBuoy(buoys.data, state.buoy, state.depth);
  const lastDate = latest(buoy.series.map((s) => s.date));
  const firstDate = earliest(buoy.series.map((s) => s.first_date));

  const range = lastDate && firstDate ? clampRange(state.from, state.to, firstDate, lastDate) : null;

  const buoyEvents = (events.data ?? []).filter((e) => e.buoy_id === buoy.id);
  // The detail follows the chosen depth when this buoy has it, else its shallowest.
  const condition = buoy.series.find((s) => s.depth === state.depth) ?? buoy.series[0];
  const detailDepth = condition?.depth ?? state.depth;

  return (
    <>
      <section className="intro">
        <h1>Marine heatwaves below the surface of the Gulf of Maine</h1>
        <p className="lead">
          Daily water temperature at 1, 20 and 50 metres on seven University of Maine buoys, two of them retired and
          kept for their history, compared with each spot's 2003–2022 normal. A marine heatwave is five or more days
          warmer than the 90th percentile for that time of year. Updated every 10 minutes from NERACOOS.
        </p>
        <Headline />
      </section>

      <div className="filters" role="group" aria-label="Depth">
        <span className="filter-label">Depth</span>
        <div className="segmented">
          {DEPTHS.map((depth) => (
            <button
              key={depth}
              type="button"
              aria-pressed={depth === state.depth}
              onClick={() => update({ depth })}
            >
              {depth} m
            </button>
          ))}
        </div>
      </div>

      <section className="now">
        <figure className="card map-card">
          <BuoyMap buoys={buoys.data} depth={state.depth} selected={buoy.id} onSelect={(id) => update({ buoy: id })} />
          <figcaption>
            <StateLegend />
          </figcaption>
        </figure>
        <div className="card">
          <h2>Latest daily mean at {state.depth} m</h2>
          <ConditionsTable
            buoys={buoys.data}
            depth={state.depth}
            selected={buoy.id}
            onSelect={(id) => update({ buoy: id })}
          />
        </div>
      </section>

      <section className="card">
        <h2>Heatwave days per year at {state.depth} m</h2>
        <p className="caption">
          Days inside a marine heatwave, by buoy and year. Click a cell to explore that buoy and year below.
        </p>
        <AnnualHeatmap
          depth={state.depth}
          buoys={buoys.data}
          selectedBuoy={buoy.id}
          from={range?.from ?? null}
          to={range?.to ?? null}
          onSelect={selectYear}
        />
      </section>

      <section className="card detail" id="detail" ref={detail} aria-labelledby="detail-title">
        <div className="detail-head">
          <h2 id="detail-title">
            <span className="code">{buoy.id}</span> {buoy.name}
          </h2>
          {condition && <StateBadge condition={condition} />}
        </div>
        {range ? (
          <BuoyDetail
            buoy={buoy}
            events={buoyEvents}
            depth={detailDepth}
            {...range}
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
          <h2>
            What the satellite misses at <span className="code">{buoy.id}</span> {buoy.name}
          </h2>
          <p className="caption">
            Heatwave days at 20 and 50 m each year, split by whether the satellite record also showed a heatwave at the
            surface above. Only days with data from both count.
          </p>
          <SatelliteMisses buoy={buoy.id} />
        </section>
      )}
    </>
  );
}

interface BuoyDetailProps {
  buoy: Buoy;
  events: HeatwaveEvent[]; // this buoy's, every depth
  depth: number; // of the range brush
  firstDate: string;
  lastDate: string;
  from: string;
  to: string;
  onRange: (from: string, to: string) => void; // a new entry in the browser history
  onBrush: (from: string, to: string) => void; // replaces the current one
}

/** One buoy's latest readings, its record over the chosen period, and the heatwaves in it. */
function BuoyDetail({ buoy, events, depth, firstDate, lastDate, from, to, onRange, onBrush }: BuoyDetailProps) {
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
        <div className="tiles">
          {buoy.satellite && (
            <div className="tile">
              <p className="tile-label">Surface, by satellite</p>
              <p className="tile-value">{formatTemp(buoy.satellite.temperature)}</p>
              <p className="tile-delta">
                {formatSigned(buoy.satellite.anomaly)} vs normal
                {buoy.satellite.date && ` · ${formatDate(buoy.satellite.date)}`}
              </p>
            </div>
          )}
          {buoy.series.map((s) => (
            <div className="tile" key={s.depth}>
              <p className="tile-label">{s.depth} m</p>
              <p className="tile-value">{formatTemp(s.temperature)}</p>
              <p className="tile-delta">
                {formatSigned(s.anomaly)} vs normal{s.date && ` · ${formatDate(s.date)}`}
              </p>
              {s.reading_at && (
                <p className="tile-reading">
                  Hourly reading {formatTemp(s.reading)} at {formatTime(s.reading_at)}
                </p>
              )}
            </div>
          ))}
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
          <p className="range-label">
            {formatDate(from)} – {formatDate(to)} ·{" "}
            {daysBetween(from, to) + 1} days
          </p>
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
          The whole record at {depth} m, with heatwaves shaded. Drag across it to choose a period.
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
          {buoy.satellite && (
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

/**
 * The share of heatwave days at 50 m, across every buoy, that the satellite record didn't show, beside the
 * same share at 1 m: two records of nearly the same water still disagree about days near the threshold.
 */
function Headline() {
  const deep = useAgreement(50);
  const shallow = useAgreement(1);
  const share = deep.data ? missedShare(deep.data) : null;
  const surface = shallow.data ? missedShare(shallow.data) : null;
  const percent = (value: number) => `${Math.round(value * 100)}%`;
  // The paragraph holds its place while the numbers load, so the page doesn't jump.
  if (share === null) return <p className="headline" aria-hidden="true" />;
  return (
    <p className="headline">
      <span className="hero">{percent(share)}</span>
      <span>
        of heatwave days at 50 m came with no heatwave at the surface above in NOAA's satellite record, the one
        GMRI's temperature reports use.
        {surface !== null &&
          ` At 1 m, where buoy and satellite see nearly the same water, it's ${percent(surface)}.`}
      </span>
    </p>
  );
}
