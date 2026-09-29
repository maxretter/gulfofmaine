import { useCallback } from "react";
import { Link, useSearchParams } from "react-router";

import { useBuoys, useEvents, useOriginRules } from "../api/queries";
import { OriginsByYear } from "../components/OriginsByYear";
import { YearByBuoy } from "../components/YearByBuoy";
import { latest } from "../lib/dates";

const DEFAULT_YEAR = 2021; // the best-studied recent onset: M01 in January, the western Gulf by April
const DEFAULT_DEPTH = 50;
const FIRST_YEAR = 2001; // the first buoy records

/** Where the heat in heatwaves at depth came from, and one year's heatwaves at every buoy. /origins?depth=50&year=2021 */
export function OriginsPage() {
  const buoys = useBuoys();
  const events = useEvents();
  const rules = useOriginRules();
  const [params, setParams] = useSearchParams();

  const depths = rules.data?.depths ?? [20, DEFAULT_DEPTH];
  const lastYear = Number((latest((buoys.data ?? []).flatMap((b) => b.series.map((s) => s.date))) ?? "2026").slice(0, 4));
  const requestedDepth = Number(params.get("depth"));
  const depth = depths.includes(requestedDepth) ? requestedDepth : DEFAULT_DEPTH;
  const requestedYear = Number(params.get("year"));
  const year = Number.isInteger(requestedYear) && requestedYear >= FIRST_YEAR && requestedYear <= lastYear ? requestedYear : DEFAULT_YEAR;
  const years = Array.from({ length: lastYear - FIRST_YEAR + 1 }, (_, i) => lastYear - i);

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

  return (
    <>
      <section className="intro">
        <p className="kicker">Origins</p>
        <h1>Where the heat came from</h1>
        <p className="lead">
          Heat reaches 20 and 50 m in the Gulf of Maine in two ways. Warm, salty slope water enters through the
          Northeast Channel and spreads west along the bottom; or heat taken up at the surface is mixed down, by wind or
          the autumn overturn. Five signals tell them apart for each heatwave, and plain rules turn them into a label,
          or into Unclear when they disagree. <Link to="/methods#origin">How the labels are made</Link>.
        </p>
      </section>

      <div className="filters" role="group" aria-label="Depth">
        <span className="filter-label">Depth</span>
        <div className="segmented">
          {depths.map((d) => (
            <button key={d} type="button" aria-pressed={d === depth} onClick={() => update({ depth: d })}>
              {d} m
            </button>
          ))}
        </div>
      </div>

      <section className="card figure">
        <h2>Heatwaves at {depth} m each year, by origin</h2>
        <p className="caption">
          By the year each began. Unclear is kept in view: it is where the signals disagree or the data are too thin.
          Click a year to see its heatwaves below.
        </p>
        {events.isError ? (
          <p className="note">Couldn't load the heatwaves.</p>
        ) : (
          <OriginsByYear events={events.data ?? []} depth={depth} year={year} onSelect={selectYear} />
        )}
      </section>

      <section className="card figure">
        <div className="detail-head">
          <h2>Every heatwave at {depth} m in {year}</h2>
          <label>
            <span className="filter-label">Year </span>
            <select className="select" value={year} onChange={(e) => update({ year: Number(e.target.value) })}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="caption">
          Each buoy's year, top to bottom in the order slope water reaches them: in through the Northeast Channel, then
          west along the coast to Massachusetts Bay. Bars are heatwaves, colored by where their heat came from, under a
          strip of the temperature against normal. Heat from offshore should reach the eastern buoys first, but
          neighboring buoys mostly warm and cool together, so that order is one clue among five. Click a heatwave for its
          evidence, or{" "}
          <Link to={`/events?depth=${depth}&year=${year}`}>list them all</Link>.
        </p>
        {buoys.data ? (
          <YearByBuoy year={year} depth={depth} buoys={buoys.data} events={events.data ?? []} />
        ) : (
          <p className="note">Loading…</p>
        )}
      </section>
    </>
  );
}
