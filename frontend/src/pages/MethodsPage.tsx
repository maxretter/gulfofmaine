import { useBuoys } from "../api/queries";
import { categories } from "../lib/colors";

export function MethodsPage() {
  const buoys = useBuoys();
  return (
    <article className="prose">
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
        Temperatures come from the University of Maine buoys A01, B01, E01, F01, I01 and M01, read from the{" "}
        <a href="https://data.neracoos.org/erddap">NERACOOS ERDDAP server</a> as NetCDF (datasets{" "}
        <code>A01_ocean_001m</code>, <code>A01_ocean_020m</code> and so on). Readings flagged bad by UMaine's own
        quality flag, or suspect or failed by the QARTOD aggregate flag, are dropped. The rest are averaged into hourly
        bins and then into UTC days; a day needs 18 hourly bins to count.
      </p>
      <p>
        An hourly job asks ERDDAP which rows changed since its last visit, using the <code>time_modified</code> column,
        and re-reads only the days those rows fall on. When UMaine replaces real-time data with post-recovery data,
        those days are picked up and recomputed automatically.
      </p>

      <h2>Normal and threshold</h2>
      <p>
        For each buoy and depth, the normal and the threshold for a calendar day are the mean and 90th percentile of
        every value within five days of it across 2003–2022, each smoothed with a 31-day running mean. Gaps of up to
        two days are interpolated; longer gaps are left empty and can't be part of a heatwave. On all 18 buoy records
        here, the detected events (688 of them, with their dates and categories) are identical to those from the
        reference implementation, <a href="https://github.com/ecjoliver/marineHeatWaves">marineHeatWaves</a>; the
        repository has the script that compares them.
      </p>

      <h2>The satellite comparison</h2>
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
                  Cell centre
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
          artefact.
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
        compares the 50 m heatwave days with the satellite's, per buoy and year.
      </p>
    </article>
  );
}
