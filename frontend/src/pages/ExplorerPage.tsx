import { useCallback, useEffect, useRef } from "react";
import { useLocation } from "react-router";

import { useBuoys, useEvents } from "../api/queries";
import type { Buoy, HeatwaveEvent } from "../api/types";
import { AnnualHeatmap } from "../components/AnnualHeatmap";
import { BuoyMap } from "../components/BuoyMap";
import { ConditionsTable } from "../components/ConditionsTable";
import { DepthCharts } from "../components/DepthCharts";
import { EventList } from "../components/EventList";
import { RangeBrush } from "../components/RangeBrush";
import { StateBadge, StateLegend, Swatch } from "../components/StateBadge";
import { categories, colors } from "../lib/colors";
import { addDays, daysBetween, maxDay, minDay } from "../lib/dates";
import { eventsInRange } from "../lib/events";
import { formatDate, formatSigned, formatTemp } from "../lib/format";
import { DEPTHS, useExplorerState } from "../state/explorer";

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
  const dates = buoy.series.flatMap((s) => (s.date ? [s.date] : []));
  const firsts = buoy.series.flatMap((s) => (s.first_date ? [s.first_date] : []));
  const lastDate = dates.reduce(maxDay);
  const firstDate = firsts.reduce(minDay);

  // Clamp the requested period to this buoy's record; fall back to the past year.
  let from = maxDay(state.from ?? addDays(lastDate, -364), firstDate);
  let to = minDay(state.to ?? lastDate, lastDate);
  if (from >= to) [from, to] = [maxDay(addDays(lastDate, -364), firstDate), lastDate];

  const buoyEvents = (events.data ?? []).filter((e) => e.buoy_id === buoy.id);
  const condition = buoy.series.find((s) => s.depth === state.depth);
  const zoomTo = (event: HeatwaveEvent) => {
    const pad = Math.max(14, Math.round(event.duration / 2));
    update({ from: maxDay(addDays(event.start_date, -pad), firstDate), to: minDay(addDays(event.end_date, pad), lastDate) });
  };
  const presets = [
    { label: "Past 12 months", from: addDays(lastDate, -364) },
    { label: "Past 5 years", from: addDays(lastDate, -5 * 365) },
    { label: "Full record", from: firstDate },
  ];

  return (
    <>
      <section className="intro">
        <h1>Marine heatwaves below the surface of the Gulf of Maine</h1>
        <p className="lead">
          Daily water temperature at 1, 20 and 50 metres on six University of Maine buoys, compared with each spot's
          2003–2022 normal. A marine heatwave is five or more days warmer than the 90th percentile for that time of
          year. Updated hourly from NERACOOS.
        </p>
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
          from={from}
          to={to}
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

        <div className="tiles">
          {buoy.series.map((s) => (
            <div className="tile" key={s.depth}>
              <p className="tile-label">{s.depth} m</p>
              <p className="tile-value">{formatTemp(s.temperature)}</p>
              <p className="tile-delta">
                {formatSigned(s.anomaly)} vs normal{s.date && ` · ${formatDate(s.date)}`}
              </p>
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
                  onClick={() => update({ from: start, to: lastDate })}
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
          depth={state.depth}
          firstDate={firstDate}
          lastDate={lastDate}
          from={from}
          to={to}
          events={buoyEvents.filter((e) => e.depth === state.depth)}
          onChange={setRange}
        />
        <p className="caption">
          The whole record at {state.depth} m, with heatwaves shaded. Drag across it to choose a period.
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
          {Object.entries(categories).map(([n, c]) => (
            <span className="state" key={n}>
              <Swatch color={c.color} variant="square" />
              {c.name}
            </span>
          ))}
        </div>
        <DepthCharts buoy={buoy} from={from} to={to} events={buoyEvents} />

        <h3>Heatwaves in this period</h3>
        <EventList
          events={eventsInRange(buoyEvents, buoy.id, from, to).sort((a, b) => a.start_date.localeCompare(b.start_date))}
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
        </p>
      </section>
    </>
  );
}
