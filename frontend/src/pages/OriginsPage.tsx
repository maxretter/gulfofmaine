import { useCallback } from "react";
import { Link, useSearchParams } from "react-router";

import { useBuoys, useEvents, useOriginRules } from "../api/queries";
import { InlineSelect } from "../components/InlineSelect";
import { OriginsByYear } from "../components/OriginsByYear";
import { YearByBuoy } from "../components/YearByBuoy";
import { earliest, latest } from "../lib/dates";
import { formatList } from "../lib/format";

const DEFAULT_YEAR = 2021; // the year the README's figures start with
const DEFAULT_DEPTH = 50;

/** Where the heat in heatwaves at depth came from, and one year's heatwaves at every buoy. /origins?depth=50&year=2021 */
export function OriginsPage() {
  const buoys = useBuoys();
  const events = useEvents();
  const rules = useOriginRules();
  const [params, setParams] = useSearchParams();

  const depths = rules.data?.depths ?? [20, DEFAULT_DEPTH];
  const requestedDepth = Number(params.get("depth"));
  const depth = depths.includes(requestedDepth) ? requestedDepth : DEFAULT_DEPTH;
  // The years of the buoys' records, the satellite's aside, the menu's once they're known; until then, any year asked
  // for is taken, as the first chart needs no buoys.
  const series = (buoys.data ?? []).flatMap((b) => b.series);
  const [first, last] = [earliest(series.map((s) => s.first_date)), latest(series.map((s) => s.date))];
  const span = first && last ? { first: Number(first.slice(0, 4)), last: Number(last.slice(0, 4)) } : null;
  const requestedYear = params.get("year") === null ? NaN : Number(params.get("year"));
  const year =
    Number.isInteger(requestedYear) && (!span || (requestedYear >= span.first && requestedYear <= span.last))
      ? requestedYear
      : DEFAULT_YEAR;
  const years = span ? Array.from({ length: span.last - span.first + 1 }, (_, i) => span.last - i) : [year];

  const update = useCallback(
    (patch: { depth?: number; year?: number }) =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const [key, value] of Object.entries(patch)) next.set(key, String(value));
          return next;
        },
        { replace: true, preventScrollReset: true },
      ),
    [setParams],
  );
  const selectYear = useCallback((y: number) => update({ year: y }), [update]);
  // Both titles choose the depth, each in its own words.
  const depthChoice = {
    label: "Depth",
    value: depth,
    options: depths.map((d) => ({ value: d, label: `${d} m` })),
    onChange: (d: number) => update({ depth: d }),
  };

  return (
    <>
      <section className="intro">
        <p className="kicker">Origins</p>
        <h1>Offshore or surface?</h1>
        <p className="lead">
          Each heatwave{rules.data && ` at ${formatList(rules.data.depths)} m`} is labeled by five signals read around
          its start: Offshore when they point to warm water arriving at depth, Surface when they point to heat from the
          surface reaching down, and Unclear when they don't agree. The labels are this site's own rules of thumb.{" "}
          <Link to="/about#origin">How the labels are made</Link>.
        </p>
      </section>

      <section className="card">
        <h2>
          Heatwaves at <InlineSelect {...depthChoice} /> each year, by origin
        </h2>
        <p className="caption">
          By the year each began. Click a year to see it below, where heatwaves that began the year before and ran
          into it show too.
        </p>
        {events.isError ? (
          <p className="note">Couldn't load the heatwaves.</p>
        ) : (
          <OriginsByYear events={events.data ?? []} depth={depth} year={year} onSelect={selectYear} />
        )}
      </section>

      <section className="card">
        <h2>
          Every heatwave at <InlineSelect {...depthChoice} /> in{" "}
          <InlineSelect
            label="Year"
            value={year}
            options={years.map((y) => ({ value: y, label: String(y) }))}
            onChange={selectYear}
          />
        </h2>
        <p className="caption">
          Buoys from east to west, with every heatwave that overlaps the year. Click a heatwave for its evidence, or{" "}
          <Link to={`/events?depth=${depth}&year=${year}`}>list them all</Link>.
        </p>
        {buoys.data ? (
          <YearByBuoy year={year} depth={depth} buoys={buoys.data} />
        ) : (
          <p className="note">Loading…</p>
        )}
      </section>
    </>
  );
}
