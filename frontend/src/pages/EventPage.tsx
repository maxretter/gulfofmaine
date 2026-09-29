import * as Plot from "@observablehq/plot";
import { useMemo } from "react";
import { Link, useParams } from "react-router";

import { type DayPoint, useBuoys, useDaily, useEvent, useEvents, useOriginRules } from "../api/queries";
import type { Buoy, EventDetail, Evidence, Onset, OriginRules, Signal, SignalDay } from "../api/types";
import { Chart } from "../components/Chart";
import { DepthCharts, SeriesLegend } from "../components/DepthCharts";
import { AtTheSameTime, EventFigures } from "../components/EventContext";
import { CategoryLabel, Label, OriginLabel, VoteLabel } from "../components/Label";
import { PlotFigure } from "../components/PlotFigure";
import { TableToggle } from "../components/TableToggle";
import { chartDefaults } from "../lib/chart";
import { categories, colors, origins } from "../lib/colors";
import { addDays, formatDay, isDay, parseDay } from "../lib/dates";
import { formatDate, formatSigned, formatTemp } from "../lib/format";
import { eventRange } from "../lib/events";
import { eastToWest, reading, SIGNALS, verdict } from "../lib/origin";
import { heatwavePeriodPath } from "../state/buoyView";

/** One heatwave: what it was, and the evidence for where its heat came from. /events/A01/50/2021-04-14 */
export function EventPage() {
  const params = useParams();
  const buoyId = (params.buoy ?? "").toUpperCase();
  const depth = Number(params.depth);
  const start = params.start ?? "";
  const valid = /^[A-Z0-9]{2,8}$/.test(buoyId) && Number.isInteger(depth) && isDay(start);
  const event = useEvent(buoyId, depth, start);
  const buoys = useBuoys();
  const events = useEvents();
  const rules = useOriginRules();

  if (!valid || event.error?.message.endsWith("404")) return <NotFoundEvent />;
  if (event.isPending || rules.isPending) return <p className="note">Loading…</p>;
  if (event.isError || rules.isError) return <p className="note">Couldn't load this heatwave.</p>;

  const detail = event.data;
  const buoy = buoys.data?.find((b) => b.id === detail.buoy_id);
  const buoyEvents = events.data?.filter((e) => e.buoy_id === detail.buoy_id) ?? [];
  const period = eventRange(detail);
  const kind = detail.category_name.toLowerCase();
  return (
    <>
      <section className="intro">
        <p className="crumbs">
          <Link to="/events">Every heatwave</Link>
        </p>
        <h1>
          <span className="code">{detail.buoy_id}</span> {buoy?.name}, {detail.depth} m
        </h1>
        <p className="lead">
          {/^[aeiou]/.test(kind) ? "An" : "A"} {kind} heatwave from {formatDate(detail.start_date)} to{" "}
          {formatDate(detail.end_date)}, peaking {formatSigned(detail.max_intensity)} above normal on{" "}
          {formatDate(detail.peak_date)}. <Link to={heatwavePeriodPath(detail)}>See it on {detail.buoy_id}'s record</Link>
          .
        </p>
        <div className="event-labels">
          <CategoryLabel category={detail.category} />
          {detail.origin ? (
            <OriginLabel origin={detail.origin} />
          ) : (
            <span className="muted">
              No origin label: only heatwaves at {rules.data.depths.join(" and ")} m get one.{" "}
              <Link to="/methods#origin">Why</Link>
            </span>
          )}
        </div>
      </section>

      <EventFigures event={detail} events={events.data} />

      {buoy && (
        <section className="card">
          <h2>Through the heatwave, at every depth</h2>
          <p className="caption">
            {detail.buoy_id}'s daily temperature from {formatDate(period.from)} to {formatDate(period.to)}, against the
            normal and the heatwave threshold, with heatwaves shaded by category. Hover to read every depth on a day.
          </p>
          <SeriesLegend buoy={buoy} />
          <DepthCharts buoy={buoy} from={period.from} to={period.to} events={buoyEvents} />
        </section>
      )}

      {detail.origin && detail.evidence && (
        <>
          <OriginCard detail={detail} rules={rules.data} buoys={buoys.data ?? []} />
          <TSCard detail={detail} rules={rules.data} />
        </>
      )}

      {events.data && buoys.data && <AtTheSameTime event={detail} events={events.data} buoys={buoys.data} />}
    </>
  );
}

function NotFoundEvent() {
  return (
    <section className="intro">
      <h1>No such heatwave</h1>
      <p className="lead">
        <Link to="/events">See every heatwave</Link>
      </p>
    </section>
  );
}

interface Day extends Omit<SignalDay, "date"> {
  date: Date;
}

interface CardProps {
  detail: EventDetail;
  rules: OriginRules;
}

/** The five signals behind the origin label, each with its reading, its vote and a small chart. */
function OriginCard({ detail, rules, buoys }: CardProps & { buoys: Buoy[] }) {
  const evidence = detail.evidence!;
  const days = useMemo(() => detail.signals.map((d) => ({ ...d, date: parseDay(d.date) })), [detail.signals]);
  const onset = parseDay(detail.start_date);

  return (
    <section className="card">
      <div className="detail-head">
        <h2>Where the heat came from</h2>
        <OriginLabel origin={detail.origin!} />
      </div>
      <p className="caption">
        {verdict(detail.origin!, evidence.votes, rules.margin)} Each signal is read from {rules.before} days before the
        onset to {rules.after} after; the dotted line marks the onset.
      </p>
      <div className="signals">
        {SIGNALS.map(({ key, name }) => (
          <div className="signal" key={key}>
            <div className="signal-head">
              <h3>{name}</h3>
              <VoteLabel vote={evidence.votes[key]} />
            </div>
            <p className="signal-reading">{reading(key, evidence, rules, detail.depth)}</p>
            <SignalChart signal={key} days={days} onset={onset} detail={detail} rules={rules} buoys={buoys} />
          </div>
        ))}
      </div>
      <SignalTable days={days} depth={detail.depth} />
    </section>
  );
}

interface SignalChartProps extends CardProps {
  signal: Signal;
  days: Day[];
  onset: Date;
  buoys: Buoy[];
}

function SignalChart({ signal, days, onset, detail, rules, buoys }: SignalChartProps) {
  if (signal === "onset_order") return <OnsetOrder detail={detail} rules={rules} buoys={buoys} />;
  if (!hasData(signal, detail.evidence!)) return null; // the reading says what's missing
  return (
    <Chart className="chart" minHeight={signal === "surface_heatwave" ? 56 : 130}>
      {(width) => <WindowChart signal={signal} days={days} onset={onset} detail={detail} rules={rules} width={width} />}
    </Chart>
  );
}

const nextDay = (day: Date) => new Date(day.getTime() + 86_400_000);

function hasData(signal: Signal, evidence: Evidence): boolean {
  switch (signal) {
    case "salinity":
      return evidence.salinity_anomaly !== null;
    case "surface_heatwave":
      return evidence.surface_heatwave_days !== null;
    case "stratification":
      return evidence.stratification_before !== null && evidence.stratification_after !== null;
    case "deep":
      return evidence.deep_heatwave_days !== null;
    case "onset_order":
      return true;
  }
}

// Small charts share a frame: dates as "Apr 14", and a right margin for labeling reference lines.
const frame = { marginTop: 22, marginRight: 64, tickFormat: "%b %-d" };

function WindowChart({ signal, days, onset, detail, rules, width }: Omit<SignalChartProps, "buoys"> & { width: number }) {
  const options = useMemo((): Plot.PlotOptions => {
    const first = days[0].date;
    const last = nextDay(days[days.length - 1].date);
    const before = { x1: first, x2: onset }; // the 30 days before onset
    const onsetRule = Plot.ruleX([onset], { stroke: colors.ink, strokeDasharray: "2,3" });
    const base = {
      ...chartDefaults,
      width,
      height: 130,
      marginTop: frame.marginTop,
      marginRight: frame.marginRight,
      x: { type: "utc" as const, domain: [first, last], label: null, ticks: "2 weeks", tickFormat: frame.tickFormat },
    };
    const tip = (y: keyof Day, format: (value: number) => string) =>
      Plot.tip(
        days.filter((d) => d[y] !== null),
        Plot.pointerX({ x: "date", y, title: (d: Day) => `${formatDate(d.date)}\n${format(d[y] as number)}` }),
      );
    // A dashed reference line, named in the right margin, clear of the data.
    const threshold = (value: number, text: string, side: "above" | "below") => [
      Plot.ruleY([value], { stroke: colors.ink2, strokeDasharray: "4,3" }),
      Plot.text([value], {
        x: last,
        y: (v: number) => v,
        text: () => text,
        textAnchor: "start",
        lineAnchor: side === "above" ? "bottom" : "top",
        dx: 6,
        dy: side === "above" ? -1 : 1,
        fill: colors.ink2,
      }),
    ];

    switch (signal) {
      case "salinity":
        return {
          ...base,
          y: { label: "vs normal", grid: true, nice: true },
          marks: [
            // Between the two thresholds, salinity doesn't vote.
            Plot.rect([rules], { y1: rules.fresh, y2: rules.salty, fill: colors.neutral }),
            ...threshold(rules.salty, "offshore", "above"),
            ...threshold(rules.fresh, "surface", "below"),
            onsetRule,
            Plot.lineY(days, { x: "date", y: "salinity_anomaly", stroke: colors.observed, strokeWidth: 2 }),
            tip("salinity_anomaly", (v) => formatSigned(v, "", 2)),
          ],
        };
      case "surface_heatwave":
        return {
          ...base,
          height: 56,
          y: { axis: null, domain: [0, 1] },
          marks: [
            Plot.rectX([before], { ...before, y1: 0, y2: 1, fill: colors.neutral }),
            Plot.rectX(
              days.filter((d) => d.surface_heatwave),
              { x1: (d: Day) => d.date, x2: (d: Day) => nextDay(d.date), y1: 0.15, y2: 0.85, fill: categories[1].color, inset: 0.5 },
            ),
            onsetRule,
            Plot.tip(
              days.filter((d) => d.surface_heatwave),
              Plot.pointerX({ x: "date", y: () => 0.5, title: (d: Day) => `${formatDate(d.date)}\nHeatwave at 1 m` }),
            ),
          ],
        };
      case "stratification":
        return {
          ...base,
          y: { label: "°C", grid: true, nice: true },
          marks: [
            Plot.ruleY([0], { stroke: colors.axis }),
            ...threshold(rules.mixed, "mixed", "below"),
            onsetRule,
            Plot.lineY(days, { x: "date", y: "stratification", stroke: colors.observed, strokeWidth: 2 }),
            // The two means the vote compares.
            Plot.ruleY(detail.evidence!.stratification_before === null ? [] : [detail.evidence!.stratification_before], {
              x1: first,
              x2: onset,
              stroke: colors.ink,
              strokeWidth: 2,
            }),
            Plot.ruleY(detail.evidence!.stratification_after === null ? [] : [detail.evidence!.stratification_after], {
              x1: onset,
              x2: last,
              stroke: colors.ink,
              strokeWidth: 2,
            }),
            tip("stratification", (v) => formatSigned(v)),
          ],
        };
      case "deep":
        return {
          ...base,
          y: { label: "°C vs normal", grid: true, nice: true },
          marks: [
            Plot.rectX([before], { ...before, fill: colors.neutral }),
            Plot.rectX(
              days.filter((d) => d.deep_heatwave),
              { x1: (d: Day) => d.date, x2: (d: Day) => nextDay(d.date), fill: categories[1].color, fillOpacity: 0.35 },
            ),
            Plot.ruleY([0], { stroke: colors.axis }),
            onsetRule,
            Plot.lineY(days, { x: "date", y: "deep_anomaly", stroke: colors.observed, strokeWidth: 2 }),
            tip("deep_anomaly", (v) => formatSigned(v)),
          ],
        };
      default:
        return base;
    }
  }, [signal, days, onset, detail, rules, width]);

  return <PlotFigure options={options} />;
}

/** Each buoy's heatwave onsets at this depth in the lookback, east at the top. */
function OnsetOrder({ detail, rules, buoys }: CardProps & { buoys: Buoy[] }) {
  const order = eastToWest(buoys, detail.depth).map((b) => b.id);
  const sides = { offshore: origins.offshore.color, western: origins.surface.color };
  const color = (onset: Onset) => (onset.group ? sides[onset.group] : colors.muted);
  return (
    <Chart
      className="chart"
      minHeight={40 + order.length * 18}
      legend={
        <div className="legend">
          <Label color={sides.offshore}>{rules.offshore_buoys.join(", ")}: offshore side</Label>
          <Label color={sides.western}>{rules.western_buoys.join(", ")}: western side</Label>
        </div>
      }
      table={{
        columns: [{ label: "Buoy" }, { label: "Heatwave began" }, { label: "Side" }],
        rows: () => detail.onsets.map((o) => [o.buoy_id, formatDate(o.date), o.group ?? "–"]),
      }}
    >
      {(width) => <OnsetDots detail={detail} rules={rules} order={order} color={color} width={width} />}
    </Chart>
  );
}

interface OnsetDotsProps extends CardProps {
  order: string[];
  color: (onset: Onset) => string;
  width: number;
}

function OnsetDots({ detail, rules, order, color, width }: OnsetDotsProps) {
  const options = useMemo((): Plot.PlotOptions => {
    const onset = parseDay(detail.start_date);
    const earliest = parseDay(addDays(detail.start_date, -rules.lookback));
    const points = detail.onsets.map((o) => ({ ...o, day: parseDay(o.date) }));
    return {
      ...chartDefaults,
      width,
      height: 40 + order.length * 18,
      marginTop: 8,
      marginRight: frame.marginRight,
      x: { type: "utc", domain: [earliest, nextDay(nextDay(onset))], label: null, ticks: "month", tickFormat: frame.tickFormat },
      y: { domain: order, label: null, grid: true },
      marks: [
        Plot.ruleX([onset], { stroke: colors.ink, strokeDasharray: "2,3" }),
        Plot.dot(points, { x: "day", y: "buoy_id", r: 5, fill: color, stroke: colors.surface, strokeWidth: 2 }),
        Plot.tip(points, Plot.pointer({ x: "day", y: "buoy_id", title: (o: Onset) => `${o.buoy_id}\nBegan ${formatDate(o.date)}` })),
      ],
    };
  }, [detail, rules, order, color, width]);
  return <PlotFigure options={options} />;
}

/** The table twin of every signal chart above, day by day. */
function SignalTable({ days, depth }: { days: Day[]; depth: number }) {
  const yes = (value: boolean) => (value ? "yes" : "");
  return (
    <TableToggle
      columns={[
          { label: "Date" },
          { label: `${depth} m vs normal`, numeric: true },
          { label: "Salinity vs normal", numeric: true },
          { label: `1 m minus ${depth} m`, numeric: true },
          { label: "Heatwave at 1 m" },
          { label: "M01 deep vs normal", numeric: true },
          { label: "M01 deep heatwave" },
      ]}
      rows={() =>
        days.map((d) => [
          formatDay(d.date),
          formatSigned(d.anomaly),
          formatSigned(d.salinity_anomaly, "", 2),
          formatSigned(d.stratification),
          yes(d.surface_heatwave),
          formatSigned(d.deep_anomaly),
          yes(d.deep_heatwave),
        ])
      }
    />
  );
}

interface TSPoint {
  date: Date;
  temperature: number;
  salinity: number;
  after: boolean; // on or after the onset
}

/** Temperature against salinity at the event's depth over the evidence window, before and after onset. */
function TSCard({ detail, rules }: CardProps) {
  const from = addDays(detail.start_date, -rules.before);
  const to = addDays(detail.start_date, rules.after);
  const temperature = useDaily(detail.buoy_id, detail.depth, from, to);
  const salinity = useDaily(detail.buoy_id, detail.depth, from, to, "salinity");
  const { points, normal } = useMemo(() => pair(temperature.data, salinity.data, detail.start_date), [
    temperature.data,
    salinity.data,
    detail.start_date,
  ]);

  return (
    <section className="card">
      <h2>Temperature and salinity at {detail.depth} m</h2>
      <p className="caption">
        Each dot is a day, from {rules.before} days before the onset to {rules.after} after. Water arriving from
        offshore moves the dots warmer and saltier; heat mixed down from the surface moves them warmer without the
        salt. The dashed line is the normal for the same days.
      </p>
      <Chart
        className="chart"
        loading={temperature.isPending || salinity.isPending}
        error={(temperature.isError || salinity.isError) && "Couldn't load the temperature and salinity."}
        minHeight={320}
        legend={
          <div className="legend">
            <Label color={colors.muted}>Before onset</Label>
            <Label color={colors.observed}>From onset</Label>
            <span className="key">
              <span className="line dashed" style={{ borderColor: colors.ink2 }} aria-hidden="true" />
              Normal
            </span>
          </div>
        }
        table={{
          columns: [
            { label: "Date" },
            { label: "Temperature", numeric: true },
            { label: "Salinity", numeric: true },
            { label: "Period" },
          ],
          rows: () =>
            points.map((p) => [
              formatDay(p.date),
              formatTemp(p.temperature),
              p.salinity.toFixed(2),
              p.after ? "from onset" : "before",
            ]),
        }}
      >
        {(width) =>
          points.length > 0 ? (
            <TSDiagram points={points} normal={normal} width={width} />
          ) : (
            temperature.data && salinity.data && <p className="note">No days with both temperature and salinity.</p>
          )
        }
      </Chart>
    </section>
  );
}

/** Days with both a temperature and a salinity, and the normal for each day of the window. */
function pair(temperature: DayPoint[] | undefined, salinity: DayPoint[] | undefined, onset: string) {
  if (!temperature || !salinity) return { points: [], normal: [] };
  const salt = new Map(salinity.map((d) => [formatDay(d.date), d]));
  const points: TSPoint[] = [];
  const normal: { temperature: number; salinity: number }[] = [];
  for (const day of temperature) {
    const s = salt.get(formatDay(day.date));
    if (!s) continue;
    normal.push({ temperature: day.climatology, salinity: s.climatology });
    if (day.value !== null && s.value !== null)
      points.push({ date: day.date, temperature: day.value, salinity: s.value, after: formatDay(day.date) >= onset });
  }
  return { points, normal };
}

function TSDiagram({ points, normal, width }: { points: TSPoint[]; normal: { temperature: number; salinity: number }[]; width: number }) {
  const options = useMemo(
    (): Plot.PlotOptions => ({
      ...chartDefaults,
      width: Math.min(width, 640),
      height: 320,
      marginBottom: 36,
      x: { label: "Salinity (practical salinity scale)", grid: true, nice: true },
      y: { label: "°C", grid: true, nice: true },
      marks: [
        Plot.line(normal, { x: "salinity", y: "temperature", stroke: colors.ink2, strokeDasharray: "4,3" }),
        Plot.line(points, { x: "salinity", y: "temperature", stroke: colors.axis, strokeWidth: 1 }),
        Plot.dot(points, {
          x: "salinity",
          y: "temperature",
          r: 4,
          fill: (p: TSPoint) => (p.after ? colors.observed : colors.muted),
          stroke: colors.surface,
          strokeWidth: 1,
        }),
        Plot.tip(
          points,
          Plot.pointer({
            x: "salinity",
            y: "temperature",
            title: (p: TSPoint) => `${formatDate(p.date)}\n${formatTemp(p.temperature)}, salinity ${p.salinity.toFixed(2)}`,
          }),
        ),
      ],
    }),
    [points, normal, width],
  );
  return <PlotFigure options={options} />;
}
