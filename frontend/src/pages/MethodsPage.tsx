import { Link } from "react-router";

import { useBuoys, useOriginRules } from "../api/queries";
import type { OriginRules } from "../api/types";
import { OriginLabel } from "../components/Label";
import { categories } from "../lib/colors";
import { formatSigned } from "../lib/format";

export function MethodsPage() {
  const buoys = useBuoys();
  const rules = useOriginRules();
  return (
    <article className="prose">
      <p className="kicker">Reference</p>
      <h1>Methods</h1>

      <h2>What a heatwave means here</h2>
      <p>
        The definition is the standard one from{" "}
        <a href="https://doi.org/10.1016/j.pocean.2015.12.014">Hobday et al. (2016)</a>: a marine heatwave is a spell of
        at least five days on which the daily mean temperature is above the 90th percentile for that time of year.
        Spells separated by two days or fewer count as one event. Each event gets a category (
        <a href="https://doi.org/10.5670/oceanog.2018.205">Hobday et al. 2018</a>) from the furthest it rose above
        normal, in multiples of the gap between the normal and the threshold:{" "}
        {Object.entries(categories)
          .map(([n, c]) => `${c.name} (${n}×${n === "4" ? " or more" : ""})`)
          .join(", ")}
        .
      </p>

      <h2>Data</h2>
      <p>
        Temperature and salinity come from the University of Maine buoys A01, B01, E01, F01, I01, M01 and N01, read
        from the <a href="https://data.neracoos.org/erddap">NERACOOS ERDDAP server</a> as NetCDF (datasets{" "}
        <code>A01_ocean_001m</code>, <code>A01_ocean_020m</code> and so on), at 1, 20 and 50 m, and at M01 also 100,
        150, 200 and 250 m. Two buoys are retired and kept for their history: M01, deep in Jordan Basin, stopped
        reporting in September 2025, and N01, in the Northeast Channel, in October 2021. Readings flagged bad by
        UMaine's own quality flag, or suspect or failed by the QARTOD aggregate flag, are dropped, for each variable
        separately. The rest are averaged into hourly bins and then into UTC days; a day needs 18 hourly bins to
        count.
      </p>
      <p>
        Every 10 minutes a job asks ERDDAP which rows changed since its last visit, using the{" "}
        <code>time_modified</code> column, and re-reads only the days those rows fall on: for each buoy still
        reporting, one small request when nothing has changed. The retired buoys and the satellite are checked hourly.
        When UMaine replaces real-time data with post-recovery data, those days are picked up and recomputed
        automatically. Each new reading, and each buoy depth entering or leaving a heatwave, is pushed to open pages
        over a WebSocket, so the map and tiles update without a reload.
      </p>

      <h2>Normal and threshold</h2>
      <p>
        For each buoy and depth, the normal and the threshold for a calendar day are the mean and 90th percentile of
        every value within five days of it across 2003–2022, each smoothed with a 31-day running mean. Gaps of up to
        two days are interpolated; longer gaps are left empty and can't be part of a heatwave. On all 25 buoy
        temperature records here, the detected events (856 of them, with their dates and categories) are identical to
        those from the reference implementation, <a href="https://github.com/ecjoliver/marineHeatWaves">marineHeatWaves</a>; the
        repository has the script that compares them.
      </p>

      <p>
        Salinity gets a normal the same way, so each day has a salinity anomaly, but it isn't searched for heatwaves.
      </p>

      <h2 id="origin">Where the heat came from</h2>
      <p>
        Heat reaches 20 and 50 m in the Gulf of Maine in two ways. Warm, salty water from the continental slope enters
        through the Northeast Channel and spreads west along the bottom from Jordan Basin. Or heat taken up at the
        surface is mixed down, by wind or by the autumn overturn. Each heatwave at 20 and 50 m is labeled{" "}
        <OriginLabel origin="offshore" />, <OriginLabel origin="surface" /> or <OriginLabel origin="unclear" /> from
        five signals, read around its onset. The labels are plain rules rather than a fitted model, so each can be
        traced to its evidence on the heatwave's own page.
      </p>
      {rules.data && <OriginTable rules={rules.data} />}
      <p>
        Each signal votes one way, or not at all when it has fewer than {rules.data?.min_days ?? 7} days of data in
        its window or can't tell. A label needs {rules.data?.margin ?? 2} more votes than the other side; anything
        closer is Unclear. The rules were checked against two onsets whose origins are known before any of this was
        built: the 2021 heatwave at 50 m, which began at M01 in January and reached A01 in April, comes out offshore,
        and the 2012 one, which began at B01 after an unusually warm winter, comes out surface.
      </p>
      <ul>
        <li>
          <strong>About half are Unclear, and that is shown.</strong> Signals often disagree, and sensors go quiet:
          since N01 stopped in 2021 and M01 in 2025, recent heatwaves have fewer signals to vote.
        </li>
        <li>
          <strong>The same fixed baseline.</strong> Anomalies are against 2003–2022, like the heatwaves. The deep
          water at M01 has warmed so much that it is warmer than that normal most of the time, so the deep-water
          signal asks whether it was in a heatwave itself, not just above normal.
        </li>
        <li>
          <strong>Salinity sensors drift.</strong> A fouling conductivity cell reads fresh, so a salinity anomaly
          below {rules.data ? formatSigned(rules.data.drift, "", 1) : "−1"} over the window is treated as a sensor
          problem and doesn't vote.
        </li>
        <li>
          <strong>Winter columns are already mixed.</strong> When 1 m is less than{" "}
          {rules.data ? formatSigned(rules.data.mixed) : "1 °C"} warmer than the depth, the surface can't lead and
          the column can't collapse, so those two signals stay out.
        </li>
      </ul>

      <h2 id="satellite">The satellite comparison</h2>
      <p>
        Each buoy is compared with sea surface temperature from NOAA's{" "}
        <a href="https://www.ncei.noaa.gov/products/optimum-interpolation-sst">OISST v2.1</a>, the daily, quarter-degree
        record behind GMRI's Gulf of Maine temperature reports, read from{" "}
        <a href="https://coastwatch.pfeg.noaa.gov/erddap">NOAA CoastWatch's ERDDAP server</a>. History comes from the
        final product (<code>ncdcOisst21Agg_LonPM180</code>), which runs about two weeks behind; the latest days come
        from the preliminary one (<code>ncdcOisst21NrtAgg_LonPM180</code>), a day behind. Each new day re-reads the past
        30, so final values replace preliminary ones as they appear.
      </p>
      <p>
        OISST masks grid cells near the coast as land, so a buoy's own cell can be empty. Each buoy is compared with
        the nearest cell that has data:
      </p>
      {buoys.data && (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Buoy</th>
                <th scope="col" className="num">
                  Cell center
                </th>
                <th scope="col" className="num">
                  Distance from the buoy
                </th>
              </tr>
            </thead>
            <tbody>
              {buoys.data.map((buoy) => (
                <tr key={buoy.id}>
                  <td>
                    {buoy.id} {buoy.name}
                  </td>
                  <td className="num">
                    {buoy.satellite?.latitude != null && buoy.satellite.longitude != null
                      ? `${buoy.satellite.latitude.toFixed(3)}° N, ${Math.abs(buoy.satellite.longitude).toFixed(3)}° W`
                      : "–"}
                  </td>
                  <td className="num">
                    {buoy.satellite?.distance_km != null ? `${buoy.satellite.distance_km.toFixed(1)} km` : "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p>
        Satellite heatwaves are found exactly as the buoys' are, against the same 2003–2022 baseline, so the two
        compare like for like. GMRI's reports use a 1991–2020 baseline, so their anomalies and heatwave days differ from
        these. The comparison counts only days with data from both the buoy depth and the satellite: each is a heatwave
        day in both, at depth only, at the surface only, or in neither.
      </p>
      <p>
        As a check, the satellite agrees closely with the buoys' own 1 m sensors: their daily values correlate at
        0.99 at every buoy, and on average differ by 0.4–0.6 °C on a given day (as of September 2026). Even so, about a
        third of 1 m heatwave days have no satellite heatwave, because two records of nearly the same water still
        disagree about days close to the threshold. That share is the yardstick for the ones at 20 and 50 m.
      </p>

      <h2>Things to keep in mind</h2>
      <ul>
        <li>
          <strong>Twenty years, not thirty.</strong> Hobday et al. recommend a 30-year baseline. The buoys' records
          begin in 2001–2003, so 2003–2022 is the longest period all of them cover.
        </li>
        <li>
          <strong>The baseline is fixed on purpose.</strong> The Gulf of Maine is warming faster than almost any other
          ocean region, so against a fixed baseline heatwaves become more common over time. That is the signal, not an
          artifact.
        </li>
        <li>
          <strong>Deep water can warm by mixing.</strong> In autumn, storms mix warm surface water downwards, so
          temperatures at 50 m can jump well above normal in a day or two. That redistributes heat rather than adding
          it, but it still counts as a heatwave for anything living at that depth.
        </li>
        <li>
          <strong>Recent values can change.</strong> The newest data are real-time transmissions; they are replaced
          when the buoy is recovered and its instruments are checked.
        </li>
        <li>
          <strong>Different from GMRI's reports.</strong> GMRI's Gulf of Maine temperature reports describe the whole
          Gulf from satellite sea surface temperature and a model for the bottom, against a 1991–2020 baseline. This
          site measures a handful of fixed points directly, at depth, and sets each beside the same satellite record at
          that spot; the two views are complementary.
        </li>
        <li>
          <strong>A grid cell is not a buoy.</strong> A satellite cell here averages about 28 km (north to south) by 20 km
          of sea surface, and the cells used sit up to about 13 km from their buoys, so some difference at the surface is expected even
          before depth comes into it.
        </li>
      </ul>

      <h2>API</h2>
      <p>
        Everything here comes from a JSON API, documented at <a href="/docs">/docs</a>. For example,{" "}
        <a href="/api/buoys">
          <code>/api/buoys</code>
        </a>{" "}
        gives the latest conditions and{" "}
        <a href="/api/events?min_category=2">
          <code>/api/events?min_category=2</code>
        </a>{" "}
        lists every heatwave that reached Strong, and{" "}
        <a href="/api/agreement?depth=50">
          <code>/api/agreement?depth=50</code>
        </a>{" "}
        compares the 50 m heatwave days with the satellite's, per buoy and year.{" "}
        <a href="/api/events/A01/50/2021-04-14">
          <code>/api/events/A01/50/2021-04-14</code>
        </a>{" "}
        gives one heatwave with the evidence for its origin,{" "}
        <a href="/api/onsets?year=2021&depth=50">
          <code>/api/onsets?year=2021&amp;depth=50</code>
        </a>{" "}
        every buoy's anomalies through a year, and{" "}
        <a href="/api/origin/rules">
          <code>/api/origin/rules</code>
        </a>{" "}
        the thresholds above. The live feed is a WebSocket at <code>/api/live</code>: JSON messages of type{" "}
        <code>reading</code> (a buoy depth's newest hourly temperature), <code>status</code> (a series entering or
        leaving a heatwave, or changing category; depth 0 is the satellite) and <code>ping</code>, every 30 seconds.
      </p>
      <p>
        The same record is published as files, NetCDF following the CF and ACDD conventions and CSV, with an ERDDAP
        configuration to serve them; the <Link to="/data">Data page</Link> lists them and shows how to open one.
      </p>
    </article>
  );
}

/** The five signals, what each says for either origin, and the thresholds it's judged by. */
function OriginTable({ rules }: { rules: OriginRules }) {
  const salt = (value: number) => formatSigned(value, "", 2);
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
            <td>{salt(rules.fresh)} or less</td>
            <td>
              {rules.before} days before onset to {rules.after} after
            </td>
          </tr>
          <tr>
            <td>Heatwave at 1 m</td>
            <td>None, in a stratified column</td>
            <td>At least one day</td>
            <td>{before}</td>
          </tr>
          <tr>
            <td>1 m minus the heatwave's depth</td>
            <td>Holds</td>
            <td>Falls below {Math.round(rules.collapse * 100)}% of what it was</td>
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
            <td>First heatwave onset at the same depth</td>
            <td>
              {east} more than {rules.together} days before {west}
            </td>
            <td>
              {west} first, or both within {rules.together} days
            </td>
            <td>{rules.lookback} days before onset</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
