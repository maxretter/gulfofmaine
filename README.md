# Gulf of Maine heatwaves, below the surface

Live marine heatwave status at 1, 20 and 50 meters on seven University of Maine
buoys in the Gulf of Maine, with the full record back to 2001, set beside the
satellite record at each buoy, and a label on every heatwave at 20 and 50 m for
where its heat likely came from. A Python job reads NERACOOS's ERDDAP server
(and NOAA's, for the satellite) every 10 minutes and applies the standard
marine heatwave definition (Hobday et al. 2016) to each depth; a FastAPI JSON
API serves the results to a React app for exploring them, and pushes new
readings to it over a WebSocket as they're stored. The whole record is also
published as CF NetCDF and CSV files, ready for ERDDAP.

**Live site:** _coming soon_ · **API docs:** `/docs` on the live site

![Now: the buoys' heatwave status at 50 m on a map and in a table, with a line saying how many are in a heatwave](docs/now.png)

## Why

Most heatwave monitoring in the Gulf of Maine is based on satellite sea-surface
temperature, which only sees the top few millimeters; below that, reports lean
on ocean models. The UMaine/NERACOOS buoys have measured temperature directly
at fixed depths since 2001–2003, but nothing publicly applies the heatwave
definition to those records. This does, so you can see whether surface heat
reaches 20 and 50 m, and when heat at depth has no surface signal at all.

Each buoy is also compared with NOAA's OISST, the satellite record behind
GMRI's Gulf of Maine temperature reports, in the nearest grid cell. On 68% of
the days the buoys logged a heatwave at 50 m, the satellite showed none at the
surface above. At 1 m, where the two measure nearly the same water, that share
is 35%, so the gap at depth is about twice what two surface records alone
produce.

Heat reaches depth in two ways: warm, salty slope water arriving from
offshore, or surface heat mixed down. Salinity, the water at 100–250 m in
Jordan Basin, and the order in which the buoys warmed tell them apart, and
plain rules turn that evidence into a label for each heatwave at 20 and 50 m,
or Unclear when it disagrees. The 2021 heatwave comes out offshore: it began at
M01 in January and reached A01 in April, in salty water. Of the 77 heatwaves at
20 and 50 m that began that year, 46 are offshore and 2 surface. The 2012
onset, after a warm winter, began in the west and comes out surface. Across the whole
record about half are Unclear, and the site says so.

The record is striking. Heatwaves that began in 2021 lasted 1,076 days in all at
20 m and 1,033 at 50 m, summed over the buoys, against 571 at 1 m. The longest
events in the record ran 165 days at 150 m in Jordan Basin (M01), from January
to June 2023, and 163 days at 20 m at F01 (West Penobscot Bay), from June to
November 2021. (Figures as of 2026-09-28.)

![F01's page for 2021: the whole record at 20 m with a brushed range, and daily temperature at three depths against the normal, the heatwave threshold and the satellite](docs/buoy.png)

## How it works

```
NERACOOS ERDDAP ──NetCDF──▶ sync job ──▶ Postgres ─NOTIFY─▶ FastAPI ──▶ Caddy ─────▶ React app
data.neracoos.org   10 min  xarray, pandas                  JSON API,   serves the   Leaflet, Observable Plot,
(buoys, tabledap)      ▲       │                            WebSocket,  app, proxies TanStack Query
                       │       │                            downloads   /api, /erddap
CoastWatch ERDDAP ─────┘       ▼                               ▲          │
(OISST, griddap)        CF NetCDF + CSV ───────────────────────┴────────▶ ERDDAP (optional)
                        products volume                                   EDDTableFromNcCFFiles
```

- **Incremental sync** ([`heatwaves/sources.py`](heatwaves/sources.py)).
  Every row in these ERDDAP datasets carries a `time_modified` stamp. Every
  10 minutes the sync job asks ERDDAP for each reporting buoy dataset's newest
  stamp (one tiny request, reduced server-side with `orderByMax`); when there
  is a new one, it asks for the span of days touched since its last visit
  (`orderByMinMax`) and downloads only those whole days as NetCDF, every
  variable of a dataset in one request. The 15 datasets still reporting make
  about 90 requests an hour when nothing has changed. Once an hour it checks
  everything else too: the satellite, and the retired buoys, whose data only
  changes when it's reprocessed. When UMaine replaces
  real-time data with post-recovery data, the reprocessed days come in the same
  way. The first run reads about 25 years of temperature and salinity for 25
  buoy depths in under a minute and a half.
- **Live updates** ([`heatwaves/live.py`](heatwaves/live.py)). The sync
  sends a Postgres `NOTIFY` with each new reading and each change of heatwave
  state, in the transaction that stores them, so nothing is announced before
  it's committed. The API holds one `LISTEN` connection and relays each
  message to browsers over a WebSocket at `/api/live`; no Redis or message
  queue. Every API response carries an ETag and `Cache-Control: no-cache`, so
  a refetch prompted by a message is never answered from a stale cache, and an
  unchanged one costs a 304. A Postgres advisory lock keeps a one-off sync
  from storing at the same time as the scheduled job.
- **Satellite sea surface temperature** (`GriddapSource` in the same file).
  NOAA OISST v2.1 from CoastWatch's ERDDAP, in the nearest quarter-degree cell
  with data to each buoy (OISST masks coastal cells as land). One request
  reads all six cells as a small box, so the first run backfills 2001 onwards
  in about 26 yearly requests, three minutes. After that, one tiny request an
  hour asks for the newest day; each new day re-reads the past 30 from the
  final product where it exists and the preliminary one after, so final values
  replace preliminary ones. Satellite heatwaves use the same method and
  2003–2022 baseline as the buoys.
- **Quality control and daily means** ([`heatwaves/qc.py`](heatwaves/qc.py)).
  Readings flagged bad by UMaine's own flag, or suspect/failed by the QARTOD
  aggregate flag, are dropped. The rest are averaged into hourly bins, then
  into UTC days; a day needs 18 hours of data.
- **Heatwave detection** ([`heatwaves/hobday.py`](heatwaves/hobday.py)) follows
  Hobday et al. (2016) and (2018): a seasonal normal and 90th-percentile threshold
  from an 11-day window pooled over 2003–2022 and smoothed over 31 days;
  events are five or more days above the threshold, joined across gaps of up to
  two days; categories run Moderate to Extreme.
- **Where the heat came from** ([`heatwaves/origin.py`](heatwaves/origin.py)).
  Five signals, read from 30 days before a heatwave's onset to 14 after, each
  vote offshore, surface, or not at all: the salinity anomaly at its depth; a
  heatwave at 1 m beforehand; whether the 1 m minus depth temperature
  difference holds or collapses; whether M01's water at 100–250 m was in a
  heatwave; and whether N01 or M01 warmed before A01 or B01. A label needs two
  more votes than the other side, else Unclear. The rules are pure functions,
  unit-tested on synthetic series, checked against the 2021 and 2012 onsets
  before any UI existed, and their thresholds are served at
  `/api/origin/rules` so the Methods page can't drift from the code. Labels and
  their evidence are stored on each event and recomputed with it.
- **The results as data** ([`heatwaves/products.py`](heatwaves/products.py)).
  After a sync round that stores new data, the job rewrites one NetCDF file
  per buoy and depth (the daily temperature, normal, threshold, anomaly and
  heatwave category, each heatwave's origin, salinity, and the satellite's
  record at the buoy) and an events table, each also as CSV. They follow the
  CF conventions 1.11 as discrete sampling geometries, one time series per
  file, with ACDD 1.3 metadata, and are built from the same reads as the JSON
  API; tests check that a download matches the API exactly and run the IOOS
  compliance checker on every file.
  [`erddap/datasets.xml`](erddap/datasets.xml), drafted by ERDDAP's
  `GenerateDatasetsXml`, serves them from ERDDAP as two datasets. Opening one
  takes three lines:

  ```python
  import xarray as xr

  ds = xr.open_dataset("http://localhost:8000/api/data/A01/50.nc#mode=bytes")
  ds.temperature_anomaly.sel(time="2021").plot()
  ```
- **Validated against the reference implementation.** On all 25 buoy/depth
  temperature records, the detected events (856 of them, with their dates and
  categories) are identical to those from Eric Oliver's
  [marineHeatWaves](https://github.com/ecjoliver/marineHeatWaves), and the
  thresholds agree to within 0.005 °C. The comparison
  script is [`scripts/compare_with_reference.py`](scripts/compare_with_reference.py).
  (It caught one bug during development: the category comes from the day
  furthest above normal in multiples of the threshold's distance, not from the
  warmest day.)

### Frontend

A React 19 + TypeScript single-page app in [`frontend/`](frontend), built with
Vite. It goes from the whole Gulf to one buoy to one heatwave, and each view
lives in the URL, so any view can be bookmarked or shared and the back button
works:

- **Now** (`/?depth=50`). Every buoy's latest daily mean at one depth, on a map
  and in a table, with a line saying how many are in a heatwave. Each buoy
  leads to its own page.
- **Buoys** (`/buoys`). Every buoy, retired ones included: its depths, the span
  of its record, how many heatwaves it has logged and whether it's in one now.
- **A page per buoy** (`/buoys/F01?depth=20&from=2021-05-01&to=2021-12-31`).
  Its latest readings and status at each depth, and its record: a strip of the
  whole record at one depth, with heatwaves shaded, sits above the detailed
  charts; drag across it to pick any period, or choose one with the presets, a
  year, or from and to dates. The heatwave list moves the brush too. Links into the single-page explorer this replaced
  (`/?buoy=F01&…`) redirect here.
- **Synchronized hover.** One chart per depth shares a time axis; hovering any of
  them moves a crosshair across all three and reads out every depth's
  temperature, anomaly and heatwave status for that day.
- **What the satellite misses** (`/satellite`). The share of heatwave days at
  50 and 20 m with no satellite heatwave at the surface above, beside the same
  share at 1 m as a yardstick; each year's heatwave days at depth split into
  days the satellite also saw a heatwave and days it saw none; and the shares at
  each buoy. Each buoy's page has its own split, and its 1 m chart carries the
  satellite's sea surface temperature as a dashed line.
- **Heatwaves** (`/events`). Heatwave days per buoy and year as a heatmap, over
  all ~860 events, filterable by buoy, depth, year, category and origin and
  sortable by date, length, intensity or category, with the filters in the URL.
  A heatmap cell filters the list to its buoy and year; each row opens that
  heatwave's page.
- **A page per heatwave** (`/events/A01/50/2021-04-14`, addressed as the API
  addresses it). Its length, peak and mean, each ranked among the buoy's other
  heatwaves at that depth, and what its category means; the temperature through
  it at every depth; and every heatwave that overlapped it, at the buoy's other
  depths and at the other buoys. At 20 and 50 m, its origin, with each of the
  five signals as a small chart over the onset window, its vote and a sentence
  on what it measured, and a temperature–salinity diagram of the water before
  and after the onset.
- **Live.** The page keeps a WebSocket open to `/api/live` and writes each
  new reading into TanStack Query's cache, so the tiles show the latest hourly
  reading and the map marker pulses as it arrives; a status change refetches
  what depends on heatwaves, and a buoy depth entering one gets a notice. The
  header says whether the feed is connected. The connection reconnects with
  backoff, drops itself if the server's 30-second pings stop, and refetches
  everything on screen once it's back, to cover what it missed.
- **Data** (`/data`). Every file with its size, the variables in them, and
  how to open one in xarray, pandas or curl.
- **Where the heat came from** (`/origins`). Heatwaves at 20 or 50 m per year,
  stacked by origin with Unclear kept in view; click a year to see it below:
  every buoy's year from east to west, in the order slope water reaches them,
  with each heatwave a bar colored by its origin under a strip of the daily
  anomaly. A heatwave opens its page.

TanStack Query caches API responses, and a period that is still loading keeps
the previous charts on screen, dimmed. Charts use Observable Plot inside one
small React frame that handles width, loading, errors and the table view; the
brush is d3-brush on top of a Plot chart. Every chart has a table view. Data
colors come from two ordinal ramps checked for lightness order, hue spread and
contrast, and the satellite's and the origins' colors were checked the same
way against the ones beside them; anomalies use a blue–gray–orange diverging
scale.

### API

| Endpoint | Returns |
| --- | --- |
| `GET /api/buoys` | Every buoy with the latest conditions at each depth, and the satellite's with its grid cell |
| `GET /api/buoys/{id}` | One buoy |
| `GET /api/buoys/{id}/{depth}/daily?start=&end=&variable=` | Daily mean, normal, threshold and anomaly of `temperature` or `salinity`; gaps are `null`; depth 0 is the satellite |
| `GET /api/events?buoy_id=&depth=&year=&min_category=&origin=` | Heatwaves at the buoys, newest first, with their origin |
| `GET /api/events/{id}/{depth}/{start}` | One heatwave with the evidence for its origin, day by day, and every buoy's onsets before it |
| `GET /api/onsets?year=&depth=` | Each buoy's first heatwave of a year, and its daily anomaly and heatwave days |
| `GET /api/origin/rules` | The thresholds the origin labels come from |
| `GET /api/annual?depth=` | Heatwave days and observed days per buoy and year |
| `GET /api/agreement?depth=` | Days per buoy and year with a heatwave at depth, at the surface by satellite, both or neither |
| `WS /api/live` | JSON messages: `reading` (a buoy depth's newest hourly temperature), `status` (a series entering or leaving a heatwave, or changing category) and `ping` every 30 s |
| `GET /api/data` | The files below, with their sizes and times, and the variables of the daily files |
| `GET /api/data/{id}/{depth}.nc` or `.csv` | A buoy depth's daily series as a CF time series, or CSV |
| `GET /api/data/events.nc` or `.csv` | Every heatwave at the buoys: CF points, or CSV with the fields of `/api/events` |
| `GET /healthz` | 200 while the sync job is current, 503 once it falls behind |

Interactive documentation (OpenAPI) is served at `/docs`.

## Running it

With Docker:

```sh
cp .env.example .env        # set POSTGRES_PASSWORD
docker compose up -d --build
```

Compose runs Postgres, a one-off `alembic upgrade head`, the API, the sync
job, and the frontend: Caddy serving the built app on
<http://localhost:8000> and forwarding `/api`, `/docs` and `/healthz` to the
API, so the browser sees a single origin. Buoy data appears after the first
sync, about a minute later, and the satellite's a few minutes after that; the
NetCDF and CSV files follow at the end of that first round.

To serve the files from ERDDAP too, as NERACOOS would, add its profile; it
runs at <http://localhost:8000/erddap> with the datasets `gom_heatwaves_daily`
and `gom_heatwaves_events` (see [`erddap/`](erddap)):

```sh
docker compose --profile erddap up -d --build
```

For development, run the backend with [uv](https://docs.astral.sh/uv/) and
SQLite, and the frontend with Vite, which forwards API requests to uvicorn:

```sh
uv sync
uv run alembic upgrade head
uv run python -m heatwaves.sync           # add --every 600 to keep going
uv run uvicorn heatwaves.main:app --reload

cd frontend && npm install && npm run dev  # http://localhost:5173
```

Checks, as CI runs them:

```sh
uv run pytest --cov      # fails under 90% coverage; SQLite unless TEST_DATABASE_URL is set;
                         # includes the IOOS compliance checker's CF and ACDD checks on the files
uv run ruff check . && uv run ruff format --check .
uv run ty check
cd frontend && npm run lint && npm test && npm run build   # build includes the type check
uv run --with scipy scripts/compare_with_reference.py      # needs network
```

The sync tests replay real ERDDAP responses recorded in `tests/data` (listed
by URL pattern in `tests/conftest.py`); the climatology and event tests use
synthetic series with known answers.

Configuration is by environment variable: `DATABASE_URL`, `ERDDAP_URL`,
`COASTWATCH_URL`, `ERDDAP_TIMEOUT`, `ERDDAP_USER_AGENT`,
`SYNC_STALE_AFTER_HOURS`, `LIVE_MAX_CLIENTS` and `PRODUCTS_DIR`, where the
files go (see [`heatwaves/config.py`](heatwaves/config.py)). The live feed
needs Postgres, for `NOTIFY`; on SQLite its WebSocket only pings. After
changing the method, run `python -m heatwaves.sync --recompute` to rebuild
every series from stored data and its files; `python -m heatwaves.products`
rewrites just the files.

## Layout

```
heatwaves/
  hobday.py      heatwave science: climatology, events, status (no I/O)
  origin.py      where a heatwave's heat came from: signals, votes, label (no I/O)
  qc.py          quality flags and daily means, for any variable (no I/O)
  compare.py     buoy against satellite heatwave days (no I/O)
  erddap.py      the few ERDDAP tabledap and griddap requests the app makes
  sources.py     what changed at each data source since the last sync
  sync.py        store, recompute, and the sync job (python -m heatwaves.sync)
  live.py        the live feed: NOTIFY from the sync, LISTEN and WebSocket in the API
  state.py       a series' state: heatwave, above threshold, normal, offline
  queries.py     reads of the stored record shared by the API and reports
  models.py      SQLAlchemy tables; migrations/ holds the Alembic history
  products.py    the record as CF NetCDF and CSV files, for downloads and ERDDAP
  api.py         JSON API; main.py wires up the FastAPI app
  stations.py    the series tracked (buoy, depth, variable, source) and baseline
frontend/src/
  pages/         now, buoys, one buoy, heatwaves, one heatwave, origins, satellite, data, methods
  components/    map, heatmap, range brush, depth charts, tables
  api/           typed API client, TanStack Query hooks and the live feed
  state/         the buoys' view <-> URL
  lib/           dates, formatting, colors, event filtering
erddap/          datasets.xml and an image that serves the files from ERDDAP
scripts/         comparison with the reference implementation
tests/           backend tests; frontend tests sit beside their code
```

## Decisions and limitations

- **A 20-year baseline.** Hobday et al. recommend 30 years; the buoy records
  begin in 2001–2003, so 2003–2022 is the longest period they all cover. The
  baseline is fixed rather than moving, so heatwaves become more frequent as
  the Gulf warms, which is the point.
- **Heat at depth isn't always new heat.** Autumn storms mix warm surface water
  down, pushing 50 m temperatures well above normal within a day or two. The
  origin labels say which heatwaves look like that; a heatwave there is still
  real for anything living at that depth.
- **Rules, not a model, for origins.** Every label has to be explainable on the
  page, so it comes from five thresholds and a vote rather than anything fitted.
  The cost is a lot of Unclear (about half), which the site shows rather than
  hides. The retired buoys (N01 since 2021, M01 since 2025) mean recent
  heatwaves have fewer signals to go on.
- **A separate frontend, one origin.** The API serves only JSON; the React app is
  static files behind Caddy, which proxies `/api`. No CORS configuration, and
  the two can be deployed and scaled independently. The trade-off is that the
  site needs JavaScript; the API remains usable on its own.
- **pandas for resampling.** xarray opens the NetCDF and computes the
  climatology, but resampling one long 1-D series is about 1,000× faster in pandas
  than in xarray without the optional `flox` package.
- **Polling, not ERDDAP's change feed.** ERDDAP announces dataset changes on
  an MQTT broker, which NERACOOS's buoy_barn subscribes to, but the broker
  needs credentials. The public alternative, each dataset's newest time in
  ERDDAP's `allDatasets` table, turned out to lag: measured on 2026-09-29, a
  reading could be queried at 02:23, but the table only showed it after
  ERDDAP's hourly reload at 02:52. So the sync asks each reporting dataset
  directly, every 10 minutes: a new reading reaches open pages within about
  10 minutes of reaching ERDDAP, at about 90 tiny requests an hour.
- **Postgres as the message bus.** The sync runs in another process than the
  API, so something has to carry "this changed" across. `NOTIFY` in the
  sync's own transaction does it with no new service, and a message can never
  describe data that didn't commit. The cost: a message sent while the API's
  `LISTEN` connection is down is lost, so the API disconnects every browser
  when it reconnects, and they refetch.
- **Files in the formats ERDDAP serves.** The products are NetCDF-3 rather
  than compressed NetCDF-4: twice the size on disk (about 1 MB a file), but
  it is what ERDDAP itself serves, any netCDF library reads it, and the
  netCDF4 package from pip can open one straight from a URL with
  `#mode=bytes`, which it can't do for NetCDF-4. Daily values are timed at
  the middle of the UTC day, as OISST's are. CF has no standard names for a
  normal, a threshold or a salinity anomaly, so those variables carry a
  `long_name` only, and the ACDD check notes their absence.
- **No accounts, admin or writes.** The site is read-only, which keeps the
  attack surface to a GET-only API and a WebSocket that only sends.

Possible next steps: marine cold spells, and subscribing to ERDDAP's MQTT
change feed instead of polling, given credentials from NERACOOS.

## Data and credits

Temperature and salinity data from buoys operated by the
[University of Maine Physical Oceanography Group](https://gyre.umeoce.maine.edu),
funded in part by NOAA through [NERACOOS](https://neracoos.org) and U.S. IOOS,
served by [NERACOOS ERDDAP](https://data.neracoos.org/erddap). The providers'
license: the data may be used and redistributed for free but are not intended
for legal use. Satellite sea surface temperature is NOAA's
[OISST v2.1](https://www.ncei.noaa.gov/products/optimum-interpolation-sst),
served by [NOAA CoastWatch ERDDAP](https://coastwatch.pfeg.noaa.gov/erddap).
Map tiles © [OpenStreetMap](https://www.openstreetmap.org/copyright)
contributors.

Hobday, A.J. et al. (2016). A hierarchical approach to defining marine
heatwaves. _Progress in Oceanography_ 141, 227–238.
[doi:10.1016/j.pocean.2015.12.014](https://doi.org/10.1016/j.pocean.2015.12.014)

Hobday, A.J. et al. (2018). Categorizing and naming marine heatwaves.
_Oceanography_ 31(2). [doi:10.5670/oceanog.2018.205](https://doi.org/10.5670/oceanog.2018.205)

Huang, B. et al. (2021). Improvements of the Daily Optimum Interpolation Sea
Surface Temperature (DOISST) Version 2.1. _Journal of Climate_ 34, 2923–2939.
[doi:10.1175/JCLI-D-20-0166.1](https://doi.org/10.1175/JCLI-D-20-0166.1)

This is an independent portfolio project, not affiliated with NERACOOS, GMRI or
the University of Maine. Code is MIT licensed.
