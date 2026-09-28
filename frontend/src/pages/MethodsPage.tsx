import { categories } from "../lib/colors";

export function MethodsPage() {
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
          <strong>Different from satellite reports.</strong> GMRI's Gulf of Maine temperature reports describe the
          whole Gulf using satellite sea-surface temperature and a model for the bottom, against a 1991–2020 baseline.
          This site measures a handful of fixed points directly, at depth, so the numbers won't match; the two are
          complementary.
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
        lists every heatwave that reached Strong.
      </p>
    </article>
  );
}
