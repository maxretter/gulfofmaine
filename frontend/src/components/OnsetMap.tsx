import * as Plot from "@observablehq/plot";
import { latLngBounds } from "leaflet";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip } from "react-leaflet";
import { Link } from "react-router";

import { useOnsets } from "../api/queries";
import type { Buoy, BuoyYear, Onsets } from "../api/types";
import { chartDefaults } from "../lib/chart";
import { anomalyColor, anomalyScale, colors } from "../lib/colors";
import { daysBetween, parseDay } from "../lib/dates";
import { eventPath } from "../lib/events";
import { formatDate, formatSigned } from "../lib/format";
import { eastToWest } from "../lib/origin";
import { Chart } from "./Chart";
import { OriginLabel } from "./Label";
import { type PlotElement, PlotFigure } from "./PlotFigure";
import { Swatch } from "./StateBadge";

const STEP_MS = 60; // playback: a year in about 20 seconds
const ROW = 26; // px per buoy in the strip

interface Props {
  year: number;
  depth: number;
  buoys: Buoy[];
}

/**
 * How one year's heatwaves spread between the buoys at one depth: a map of
 * each buoy's anomaly on a chosen day, played through the year, over a strip
 * of every buoy's year, east to west, that doubles as the scrubber.
 */
export function OnsetMap({ year, depth, buoys }: Props) {
  const onsets = useOnsets(year, depth);
  const order = useMemo(() => eastToWest(buoys, depth), [buoys, depth]);
  const orderIds = useMemo(() => order.map((b) => b.id), [order]);
  const data = onsets.data;
  const byBuoy = useMemo(() => new Map(data?.buoys.map((b) => [b.buoy_id, b])), [data]);

  const [day, setDay] = useState(0);
  const [playing, setPlaying] = useState(false);
  // A new year opens on the day its last buoy's first heatwave began: the spread at its widest.
  const [shownFor, setShownFor] = useState<Onsets | null>(null);
  if (data && data !== shownFor && !onsets.isPlaceholderData) {
    setShownFor(data);
    setDay(openingDay(data));
    setPlaying(false);
  }

  useEffect(() => {
    if (!playing || !data) return;
    const timer = setInterval(() => {
      setDay((current) => {
        if (current + 1 >= data.dates.length) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, STEP_MS);
    return () => clearInterval(timer);
  }, [playing, data]);

  const scrub = useCallback((index: number) => {
    setPlaying(false);
    setDay(index);
  }, []);

  if (onsets.isError) return <p className="note">Couldn't load that year.</p>;
  const date = data?.dates[Math.min(day, (data?.dates.length ?? 1) - 1)];

  return (
    <div className={onsets.isPlaceholderData ? "loading" : undefined}>
      <div className="playback">
        <button
          type="button"
          className="play"
          disabled={!data}
          onClick={() => {
            if (!data) return;
            if (!playing && day >= data.dates.length - 1) setDay(0);
            setPlaying(!playing);
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <input
          type="range"
          min={0}
          max={(data?.dates.length ?? 1) - 1}
          value={day}
          disabled={!data}
          onChange={(e) => scrub(Number(e.target.value))}
          aria-label="Day of the year"
        />
        <span className="playback-date" aria-live="off">
          {date ? formatDate(date) : "…"}
        </span>
      </div>

      <div className="onset-now">
        <DayMap buoys={order} byBuoy={byBuoy} day={day} depth={depth} />
        <DayTable buoys={order} byBuoy={byBuoy} day={day} depth={depth} />
      </div>

      {data && <OnsetStrip data={data} order={orderIds} day={day} onScrub={scrub} />}
    </div>
  );
}

function openingDay(data: Onsets): number {
  const onsets = data.buoys.flatMap((b) => (b.onset ? [b.onset] : []));
  if (!onsets.length) return 0;
  const last = onsets.reduce((a, b) => (b > a ? b : a));
  return daysBetween(data.dates[0], last);
}

interface DayProps {
  buoys: Buoy[];
  byBuoy: Map<string, BuoyYear>;
  day: number;
}

function DayMap({ buoys, byBuoy, day, depth }: DayProps & { depth: number }) {
  // Read once: the map frames the buoys on mount, then the view belongs to the reader.
  const [bounds] = useState(() => latLngBounds(buoys.map((b) => [b.latitude!, b.longitude!])));
  return (
    <MapContainer
      bounds={bounds}
      boundsOptions={{ padding: [40, 40] }}
      scrollWheelZoom={false}
      className="map"
      aria-label={`Map of the buoys, coloured by temperature anomaly at ${depth} m`}
    >
      <TileLayer
        url="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
        maxZoom={12}
      />
      {buoys.map((buoy) => {
        const year = byBuoy.get(buoy.id);
        const fill = anomalyColor(year?.anomaly[day] ?? null);
        const heatwave = year?.heatwave[day] ?? false;
        const style = fill
          ? { fillColor: fill, fillOpacity: 1, color: heatwave ? colors.ink : colors.surface, weight: heatwave ? 3 : 1.5 }
          : { color: colors.axis, weight: 2, fillOpacity: 0 };
        return (
          <CircleMarker key={buoy.id} center={[buoy.latitude!, buoy.longitude!]} radius={10} pathOptions={style}>
            <Tooltip permanent direction="right" offset={[12, 0]} className="buoy-label">
              {buoy.id}
            </Tooltip>
          </CircleMarker>
        );
      })}
    </MapContainer>
  );
}

function DayTable({ buoys, byBuoy, day, depth }: DayProps & { depth: number }) {
  return (
    <table className="conditions">
      <thead>
        <tr>
          <th scope="col">Buoy</th>
          <th scope="col" className="num">
            vs normal
          </th>
          <th scope="col">First heatwave this year</th>
        </tr>
      </thead>
      <tbody>
        {buoys.map((buoy) => {
          const year = byBuoy.get(buoy.id);
          const anomaly = year?.anomaly[day] ?? null;
          return (
            <tr key={buoy.id} className={anomaly === null ? "offline" : undefined}>
              <th scope="row">
                <span className="code">{buoy.id}</span>
                <span className="buoy-name">{buoy.name}</span>
              </th>
              <td className="num">
                {anomaly === null ? "no data" : formatSigned(anomaly)}
                {year?.heatwave[day] && <span className="heatwave-flag">heatwave</span>}
              </td>
              <td>
                {year?.onset ? (
                  <span className="onset-cell">
                    <Link to={eventPath({ buoy_id: buoy.id, depth, start_date: year.onset })}>{formatDate(year.onset)}</Link>
                    {year.origin && <OriginLabel origin={year.origin} />}
                  </span>
                ) : (
                  <span className="muted">none</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

interface StripProps {
  data: Onsets;
  order: string[];
  day: number;
  onScrub: (day: number) => void;
}

interface Cell {
  buoy: string;
  date: Date;
  index: number;
  anomaly: number | null;
  heatwave: boolean;
}

/** Every buoy's year, east at the top: the anomaly day by day, a bar under heatwave days, a dot at the first onset. */
function OnsetStrip({ data, order, day, onScrub }: StripProps) {
  const cells = useMemo(
    () =>
      data.buoys.flatMap((b) =>
        data.dates.map((date, index) => ({
          buoy: b.buoy_id,
          date: parseDay(date),
          index,
          anomaly: b.anomaly[index],
          heatwave: b.heatwave[index],
        })),
      ),
    [data],
  );
  // Stable across days of playback, so the strip is drawn once per year, not once per frame.
  const rows = useMemo(() => order.filter((id) => data.buoys.some((b) => b.buoy_id === id)), [order, data]);
  return (
    <Chart
      className="chart onset-strip"
      minHeight={40 + rows.length * ROW}
      legend={
        <div className="legend">
          <AnomalyLegend />
          <span className="key">
            <span className="heatwave-bar" aria-hidden="true" />
            Heatwave day
          </span>
          <span className="state">
            <Swatch color={colors.ink} />
            First heatwave of the year
          </span>
        </div>
      }
      table={{
        columns: [{ label: "Buoy" }, { label: "First heatwave" }, { label: "Heatwave days", numeric: true }],
        rows: () =>
          rows.map((id) => {
            const b = data.buoys.find((x) => x.buoy_id === id)!;
            return [id, b.onset ? formatDate(b.onset) : "none", b.heatwave.filter(Boolean).length];
          }),
      }}
    >
      {(width) => <Strip cells={cells} data={data} rows={rows} day={day} width={width} onScrub={onScrub} />}
    </Chart>
  );
}

interface StripChartProps extends Omit<StripProps, "order"> {
  cells: Cell[];
  rows: string[]; // buoys with data this year, east to west
  width: number;
}

function Strip({ cells, data, rows, day, width, onScrub }: StripChartProps) {
  const [x, setX] = useState<Plot.Scale | null>(null);
  const options = useMemo((): Plot.PlotOptions => {
    const first = parseDay(data.dates[0]);
    const end = new Date(parseDay(data.dates[data.dates.length - 1]).getTime() + 86_400_000);
    const next = (d: Cell) => new Date(d.date.getTime() + 86_400_000);
    const onsets = data.buoys.flatMap((b) => (b.onset ? [{ buoy: b.buoy_id, date: parseDay(b.onset) }] : []));
    return {
      ...chartDefaults,
      width,
      height: 30 + rows.length * ROW,
      marginTop: 4,
      x: { type: "utc", domain: [first, end], label: null, tickFormat: "%b" },
      y: { domain: rows, label: null, padding: 0.12 },
      marks: [
        Plot.rect(
          cells.filter((c) => c.anomaly !== null),
          { x1: "date", x2: next, y: "buoy", fill: (c: Cell) => anomalyColor(c.anomaly) },
        ),
        Plot.rect(
          cells.filter((c) => c.heatwave),
          { x1: "date", x2: next, y: "buoy", fill: colors.ink, insetTop: ROW * 0.88 - 7 },
        ),
        Plot.dot(onsets, { x: "date", y: "buoy", r: 4, fill: colors.ink, stroke: colors.surface, strokeWidth: 1.5 }),
        Plot.tip(
          cells,
          Plot.pointer({
            x1: "date",
            x2: next,
            y: "buoy",
            title: (c: Cell) =>
              `${c.buoy}, ${formatDate(c.date)}\n${c.anomaly === null ? "no data" : `${formatSigned(c.anomaly)} vs normal`}${
                c.heatwave ? "\nIn a heatwave" : ""
              }`,
          }),
        ),
      ],
    };
  }, [cells, data, rows, width]);

  const onRender = useCallback(
    (plot: PlotElement) => {
      setX(plot.scale("x") ?? null);
      const click = () => {
        if (plot.value) onScrub(plot.value.index);
      };
      plot.addEventListener("click", click);
      return () => plot.removeEventListener("click", click);
    },
    [onScrub],
  );

  const at = x ? x.apply(parseDay(data.dates[day])) : null;
  return (
    <div className="strip-frame">
      <PlotFigure options={options} onRender={onRender} />
      {at !== null && <div className="day-marker" style={{ left: at }} aria-hidden="true" />}
    </div>
  );
}

function AnomalyLegend() {
  const legend = useMemo(
    () =>
      Plot.legend({
        color: { type: "linear", domain: anomalyScale.domain, range: anomalyScale.range, clamp: true, interpolate: "lab" },
        label: "°C vs normal",
        width: 220,
        ticks: 5,
        tickFormat: (v: number) => (v > 0 ? `+${v}` : v < 0 ? `−${-v}` : "0"),
      }),
    [],
  );
  return <span className="anomaly-legend" ref={(node) => node?.replaceChildren(legend)} />;
}
