import { Fragment } from "react";
import { Navigate, useLocation } from "react-router";

import { useBuoys, useDataCatalog, useMethod, useOriginRules } from "../api/queries";
import type { Method, OriginRules } from "../api/types";
import { ProductTable } from "../components/DataTables";
import { OriginLabel } from "../components/Label";
import { ORIGINS } from "../lib/colors";
import { formatList, formatOrdinal, formatSigned } from "../lib/format";
import { baselineLength, baselineYears, categoryScale, dayCountsFrom, inWords } from "../lib/method";

const REPOSITORY = "https://github.com/maxretter/gulfofmaine";

/**
 * How the site finds and labels heatwaves, where its data come from, and how to get them. Every statement here is one
 * the code or the data backs. /about, and /methods and /data before them (router.tsx sends those here).
 */
export function AboutPage() {
  const buoys = useBuoys();
  const method = useMethod();
  const rules = useOriginRules();
  const catalog = useDataCatalog();
  const names = new Map(buoys.data?.map((buoy) => [buoy.id, buoy.name]));
  const farthest = Math.max(0, ...(buoys.data ?? []).map((b) => b.satellite?.distance_km ?? 0));

  return (
    <article className="prose">
      <p className="kicker">About</p>
      <h1>Methods and data</h1>
      <p className="lead">How heatwaves are found and labeled here, where the data come from, and how to get them.</p>

      <h2 id="heatwaves">Heatwaves</h2>
      {method.data ? (
        <HeatwaveMethod method={method.data} />
      ) : (
        method.isError && <p className="note">The method's parameters didn't load.</p>
      )}

      <h2 id="sources">Data</h2>
      <p>
        Temperature and salinity come from the University of Maine buoys A01, B01, E01, F01, I01, M01 and N01, at 1, 20
        and 50 m and at M01 also 100–250 m, through the{" "}
        <a href="https://data.neracoos.org/erddap">NERACOOS ERDDAP server</a>, checked about every 10 minutes. A reading
        is kept only if UMaine's quality flag marks it good and the QARTOD flag doesn't mark it suspect or failed; in
        September 2026 the QARTOD flag marked no reading suspect, and failed only readings UMaine's flag already
        marks.{" "}
        {method.data && (
          <>
            Readings are averaged by hour, then by day, and a day needs {method.data.min_hours} hours with data, so the
            current day counts from about {dayCountsFrom(method.data)} on the hours so far.{" "}
          </>
        )}
        M01 has sent no data since September 2025 and N01 since October 2021; their records are kept.
      </p>

      <h2 id="origin">Origin labels</h2>
      {rules.data ? (
        <OriginRulesText rules={rules.data} />
      ) : (
        rules.isError && <p className="note">The origin rules didn't load.</p>
      )}

      <h2 id="satellite">Satellite comparison</h2>
      <p>
        The satellite record is NOAA's{" "}
        <a href="https://www.ncei.noaa.gov/products/optimum-interpolation-sst">OISST v2.1</a>, a daily sea surface
        temperature analysis on a quarter-degree grid, from{" "}
        <a href="https://coastwatch.pfeg.noaa.gov/erddap">NOAA CoastWatch's ERDDAP server</a>. Each buoy but N01 is
        compared with the nearest grid cell that has data
        {farthest > 0 && `, at most ${Math.ceil(farthest)} km away`}. Satellite heatwaves are found the same way as the
        buoys', against the cell's own {method.data && `${baselineYears(method.data)} `}normal, and only days with data
        from both are compared.
      </p>
      <p>
        At 1 m, about a third of heatwave days have no satellite heatwave. That share is the one to hold the 20 and 50 m
        figures against, though each depth's share pools its own heatwave days from every buoy, so they don't rest on
        the same days.
      </p>

      <h2 id="data">API and files</h2>
      <p>
        Everything on the site comes from a JSON API, documented at <a href="/docs">/docs</a>. The record is also
        published as files, rewritten as new data arrive: each buoy depth's daily series at{" "}
        <code>/api/data/A01/50.nc</code> (or <code>.csv</code>), and every heatwave at <code>/api/data/events.nc</code>{" "}
        (or <code>.csv</code>). The NetCDF files carry CF-1.11 and ACDD-1.3 metadata, and the repository has an{" "}
        <a href={`${REPOSITORY}/tree/main/erddap`}>ERDDAP configuration</a> to serve them.
      </p>
      {catalog.isError && <p className="note">The list of files didn't load.</p>}
      {catalog.data && catalog.data.products.length > 0 && (
        <details className="table-view">
          <summary>Every file ({catalog.data.products.length})</summary>
          <ProductTable products={catalog.data.products} names={names} />
        </details>
      )}
    </article>
  );
}

/** The pages this one replaced: a link to /methods#origin, say, lands on the same section here. */
export function MovedToAbout({ section }: { section?: string }) {
  const { hash } = useLocation();
  return <Navigate replace to={{ pathname: "/about", hash: hash || (section ? `#${section}` : "") }} />;
}

/** How heatwaves are found, with the numbers heatwaves/hobday.py and heatwaves/stations.py use. */
function HeatwaveMethod({ method }: { method: Method }) {
  const percentile = formatOrdinal(method.percentile);
  const days = `${inWords(method.min_duration)} days`;
  return (
    <>
      <p>
        A marine heatwave is at least {days} in a row above the {percentile} percentile for the time of year, with
        spells {inWords(method.max_gap)} days apart or less joined into one, following{" "}
        <a href="https://doi.org/10.1016/j.pocean.2015.12.014">Hobday et al. (2016)</a>. Up to{" "}
        {inWords(method.max_pad)} missing days in a row are filled in; a longer gap in the data ends a heatwave, and
        each side of it must last {days} to count. The normal and the {percentile} percentile are computed as in that
        paper, for each buoy and depth, from the years {baselineYears(method)} that it has data for. A record needs data
        on at least half the days of those years, however they fall through the year, so for a season it often missed,
        its normal rests on fewer years. Its category follows{" "}
        <a href="https://doi.org/10.5670/oceanog.2018.205">Hobday et al. (2018)</a>: how far above normal it rose, in
        multiples of the gap between the normal and the threshold: {categoryScale(method)}.
      </p>
      <p>
        Hobday et al. base their definition on a 30-year baseline; these records allow{" "}
        {inWords(baselineLength(method))}. The normal is fixed, so if the water warms over the years, heatwaves against
        it become more frequent. On all 25 buoy temperature records here, the heatwaves found match exactly those of the
        reference implementation, <a href="https://github.com/ecjoliver/marineHeatWaves">marineHeatWaves</a>, set to
        fill gaps of up to {inWords(method.max_pad)} days as here (checked September 2026 with the repository's script).
      </p>
    </>
  );
}

/** The origin labels and how they're voted, with the numbers heatwaves/origin.py uses. */
function OriginRulesText({ rules }: { rules: OriginRules }) {
  const four = [...rules.offshore_buoys, ...rules.western_buoys];
  const [west, ...rest] = rules.western_buoys; // a buoy on the western side, and the others there
  return (
    <>
      <p>
        Each heatwave at {formatList(rules.depths)} m is labeled{" "}
        {ORIGINS.map((origin, i) => (
          <Fragment key={origin}>
            {i > 0 && (i === ORIGINS.length - 1 ? " or " : ", ")}
            <OriginLabel origin={origin} />
          </Fragment>
        ))}{" "}
        by five signals read around its start. These are this site's own rules of thumb, not a published or tested
        method.
      </p>
      <OriginTable rules={rules} />
      <p>
        A signal that meets neither column, or lacks the data, doesn't vote. 1 m minus the depth reads only the
        difference, which falls whether 1 m cools or the depth warms; either way, a fall below{" "}
        {Math.round(rules.collapse * 100)}% votes surface. The onset order leaves out the heatwave's own buoy: for a
        heatwave at {west}, the western side is just {formatList(rest)}. So its own onset never counts, one at any of
        the {inWords(four.length)} with no onset at the other {inWords(four.length - 1)} doesn't vote, and an onset on
        one side alone votes only if a buoy left on the other had data on at least {Math.floor(rules.lookback / 2)} days
        of the window. A label needs {rules.margin} more votes than the other side; otherwise it's Unclear, as about
        half are. Every vote is shown on the heatwave's own page.
      </p>
    </>
  );
}

/** The five signals and how each votes, exactly as heatwaves/origin.py applies them. */
function OriginTable({ rules }: { rules: OriginRules }) {
  const salt = (value: number) => formatSigned(value, "", 2);
  const mixed = `${rules.mixed.toFixed(1)} °C`;
  const east = rules.offshore_buoys.join(" or ");
  const west = rules.western_buoys.join(" or ");
  const before = `${rules.before} days before onset`;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th scope="col">Signal</th>
            <th scope="col">Offshore</th>
            <th scope="col">Surface</th>
            <th scope="col">Read over</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td>Salinity anomaly at the heatwave's depth</td>
            <td>{salt(rules.salty)} or more</td>
            <td>
              {salt(rules.fresh)} down to {salt(rules.drift)}
            </td>
            <td>
              {rules.before} days before onset to {rules.after} after
            </td>
          </tr>
          <tr>
            <td>Heatwave at 1 m</td>
            <td>None, with 1 m at least {mixed} warmer than the depth</td>
            <td>At least one day</td>
            <td>{before}</td>
          </tr>
          <tr>
            <td>1 m minus the heatwave's depth, if at least {mixed} before onset</td>
            <td>Stays at {Math.round(rules.collapse * 100)}% of what it was or more</td>
            <td>Falls below {Math.round(rules.collapse * 100)}%</td>
            <td>{before}, against onset to {rules.after} days after</td>
          </tr>
          <tr>
            <td>
              {rules.deep_buoy} at {rules.deep_depths[0]}–{rules.deep_depths.at(-1)} m
            </td>
            <td>In a heatwave</td>
            <td>Not in a heatwave</td>
            <td>{before}</td>
          </tr>
          <tr>
            <td>
              First heatwave at the same depth at {east}, and at {west}, leaving out the heatwave's own buoy
            </td>
            <td>
              {east} more than {rules.together} days first, or only there
            </td>
            <td>
              {west} first, within {rules.together} days, or only there
            </td>
            <td>{rules.lookback} days before onset, and the onset day</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
