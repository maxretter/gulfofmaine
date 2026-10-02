# ERDDAP

[`datasets.xml`](datasets.xml) serves the products that `heatwaves/products.py`
writes as two ERDDAP datasets:

| Dataset | Files | cdm_data_type |
| --- | --- | --- |
| `gom_heatwaves_daily` | `daily/*_heatwaves_*m.nc`, one CF time series per buoy and depth | TimeSeries |
| `gom_heatwaves_events` | `gom_heatwaves_events.nc`, one CF point per heatwave | Point |

`docker compose --profile erddap up -d --build` runs it beside the site at
<http://localhost:8000/erddap>, reading the same products volume the API
serves downloads from. To add the datasets to another ERDDAP, copy the two
`<dataset>` elements and point each `fileDir` at the files.

## How it was made

Drafted with ERDDAP 2.31.1's `GenerateDatasetsXml` from real files, then edited
by hand, as its disclaimer asks:

```sh
docker run --rm -e ERDDAP_flagKeyKey=local -v "$PWD/products:/data/products:ro" \
  --entrypoint bash axiom/docker-erddap:v2.31.1 -c 'cd webapps/erddap/WEB-INF &&
  bash GenerateDatasetsXml.sh EDDTableFromNcCFFiles /data/products/daily/ ".*\.nc" "" 10080 \
    "" "" "" "" "" "" "" "" "" "" "" </dev/null; cat /erddapData/logs/GenerateDatasetsXml.out'
```

and the same for `gom_heatwaves_events\.nc` in `/data/products/`. The edits:

- Dataset IDs, and a title, summary and `id` for the whole dataset rather than
  the last file's; `platform_id` and `platform_name` removed for the same reason.
- `cdm_timeseries_variables` (left as `???`) and `subsetVariables` set to the
  per-series variables.
- The standard names it guessed removed: `sea_water_practical_salinity` on
  `salinity_hours`, the observed variable's name on each normal, `latitude` and
  `longitude` on the satellite cell's position, `time` on the events' last and
  peak days. The files carry the standard names that apply.
- Its keywords (which included land surface temperature and surface waves)
  replaced with the files' GCMD keywords; `ioos_category` and color-bar ranges
  set for the Gulf of Maine.
- The events file's `event` index variable left out.

[`tests/test_erddap.py`](../tests/test_erddap.py), which CI runs against this
image serving the sample products (`tests/sample.py`), checks that both
datasets load, that every variable in the daily files is served, that every
daily value ERDDAP serves matches the NetCDF files exactly (the daily CSV
files round to 0.001), and that the events' buoys, start days, peak
intensities and origins match the events file.
