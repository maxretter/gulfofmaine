import { useBuoys, useDataCatalog } from "../api/queries";
import { ProductTable, VariableTable } from "../components/DataTables";
import { latest } from "../lib/dates";

const REPOSITORY = "https://github.com/maxretter/gulfofmaine";

/** The record as files: each buoy depth's daily series and every heatwave, as NetCDF and CSV. /data */
export function DataPage() {
  const catalog = useDataCatalog();
  const buoys = useBuoys();
  const names = new Map(buoys.data?.map((buoy) => [buoy.id, buoy.name]));
  const written = latest(catalog.data?.products.flatMap((product) => product.files.map((f) => f.modified)) ?? []);
  const site = window.location.origin;

  return (
    <article className="prose">
      <p className="kicker">Reference</p>
      <h1>Data</h1>
      <p className="lead">
        Everything on this site as files: each buoy depth's daily record and every heatwave, as NetCDF and as CSV.
        The sync job rewrites them whenever new data arrive, so they are as current as the charts.
      </p>

      <h2>Open one in Python</h2>
      <pre>
        <code>{`import xarray as xr
ds = xr.open_dataset("${site}/api/data/A01/50.nc#mode=bytes")
ds.temperature_anomaly.sel(time="2021").plot()`}</code>
      </pre>
      <p>
        With <code>#mode=bytes</code> the netCDF library reads only the parts it needs over HTTP. The events table
        works as it is in pandas:
      </p>
      <pre>
        <code>{`import pandas as pd
events = pd.read_csv(
    "${site}/api/data/events.csv",
    parse_dates=["start_date", "end_date", "peak_date"],
)
events[events.origin == "offshore"].groupby("depth").duration.sum()`}</code>
      </pre>
      <p>
        Or download a file: <code>curl -OJ {site}/api/data/A01/50.nc</code>
      </p>

      <h2>Files</h2>
      {catalog.isError && <p className="note">The list of files didn't load.</p>}
      {catalog.data &&
        (catalog.data.products.length ? (
          <>
            <ProductTable products={catalog.data.products} names={names} />
            {written && <p className="muted">Written {new Date(written).toUTCString().slice(5, 22)} UTC.</p>}
          </>
        ) : (
          <p className="note">No files yet: the sync job writes them at the end of its first run.</p>
        ))}

      <h2>The daily files</h2>
      <p>
        One file per buoy and depth, with a row for every UTC day from its first with data to its last. Time is the
        middle of each day, as in NOAA's OISST. Missing values are NaN in NetCDF and empty in CSV, where the origin is
        written as a word. The values are the ones the charts and <a href="/docs">the API</a> show, and a test checks
        that they match exactly.
      </p>
      {catalog.data && <VariableTable variables={catalog.data.variables} />}

      <h2>The events table</h2>
      <p>
        One row per heatwave at the buoys, oldest first, with the fields of{" "}
        <a href="/api/events">
          <code>/api/events</code>
        </a>
        : buoy and depth, first, last and peak day, duration in days, the peak and mean anomaly in °C, the category
        (1 Moderate to 4 Extreme), and at 20 and 50 m the origin. In NetCDF each heatwave is a point at its buoy and
        depth, timed at its first day, with the category and origin as flags.
      </p>

      <h2>Conventions and ERDDAP</h2>
      <p>
        The NetCDF files are NetCDF-3, the format ERDDAP serves, and follow the{" "}
        <a href="https://cfconventions.org/">CF conventions</a> 1.11 as discrete sampling geometries: each daily file
        is one time series (<code>featureType = timeSeries</code>) named by <code>series_id</code>, such as{" "}
        <code>A01_050m</code>, and the events file is a set of points. Their metadata follows{" "}
        <a href="https://wiki.esipfed.org/Attribute_Convention_for_Data_Discovery_1-3">ACDD 1.3</a>. Every build checks
        each file with the <a href="https://github.com/ioos/compliance-checker">IOOS compliance checker</a>: they pass
        its CF check, and its ACDD check apart from standard names for quantities CF has none for (a normal or a
        threshold, say) and a contact email.
      </p>
      <p>
        The repository's <a href={`${REPOSITORY}/tree/main/erddap`}>erddap/datasets.xml</a> serves the files from an
        ERDDAP server as two datasets, <code>gom_heatwaves_daily</code> and <code>gom_heatwaves_events</code>, with{" "}
        <code>EDDTableFromNcCFFiles</code>, the way NERACOOS serves its buoys; Compose's <code>erddap</code> profile
        runs one beside this site.
      </p>
    </article>
  );
}
