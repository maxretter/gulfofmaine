"""Bring the database up to date with ERDDAP, then recompute heatwaves.

    python -m heatwaves.sync               # once
    python -m heatwaves.sync --every 3600  # hourly, until stopped

Each series is fetched incrementally using ERDDAP's `time_modified` column,
which the data provider stamps on every row it writes. Two small requests,
reduced server-side with orderByMax and orderByMinMax, find the newest stamp
and the span of days touched since the last sync; only those days are then
downloaded and re-averaged. A normal hourly sync re-reads a couple of days
per series. When UMaine replaces real-time data with post-recovery data, the
new stamps pull the reprocessed days in automatically. The first sync reads
each series' full history, about 25 years.
"""

import argparse
import datetime as dt
import logging
import sys
import time

import httpx
import pandas as pd
from sqlalchemy import delete, insert, select
from sqlalchemy.orm import Session, sessionmaker

from heatwaves import hobday
from heatwaves.config import settings
from heatwaves.erddap import Erddap, format_time, parse_time
from heatwaves.models import Buoy, ClimatologyDay, DailyMean, Event, Series
from heatwaves.stations import BASELINE, BUOYS, DEPTHS, dataset_id

log = logging.getLogger(__name__)

VARIABLES = ["time", "temperature", "temperature_qc", "temperature_qc_agg"]

# Rows can reach ERDDAP after rows with later time_modified stamps. Whenever
# anything new has been stamped, the sync re-reads this far behind the newest
# stamp it had already seen, to catch them.
OVERLAP = dt.timedelta(days=2)


def ensure_catalog(session: Session, erddap: Erddap) -> None:
    """Create rows for every buoy and series in `stations`, with positions from ERDDAP."""
    surface = {dataset_id(buoy, DEPTHS[0]): buoy for buoy in BUOYS}
    positions = {
        surface[row["datasetID"]]: row
        for row in erddap.rows(
            "allDatasets",
            ["datasetID", "minLatitude", "minLongitude"],
            [f'datasetID=~"^({"|".join(surface)})$"'],
        )
    }
    for code, name in BUOYS.items():
        buoy = session.get(Buoy, code) or Buoy(id=code)
        buoy.name = name
        if code in positions:
            buoy.latitude = positions[code]["minLatitude"]
            buoy.longitude = positions[code]["minLongitude"]
        session.add(buoy)
        for depth in DEPTHS:
            exists = session.scalar(select(Series.id).where(Series.buoy_id == code, Series.depth == depth))
            if exists is None:
                session.add(Series(buoy_id=code, depth=depth, dataset_id=dataset_id(code, depth)))
    session.commit()


def sync_series(session: Session, erddap: Erddap, series: Series) -> bool:
    """Fetch what changed in one series and recompute it. True if anything was read."""
    since = []
    if series.modified_through is not None:
        since = [f"time_modified>{format_time(series.modified_through - OVERLAP)}"]

    newest = erddap.rows(series.dataset_id, ["time_modified"], [*since, 'orderByMax("time_modified")'])
    series.synced_at = dt.datetime.now(dt.UTC)
    if not newest:
        session.commit()
        return False

    modified_through = parse_time(newest[0]["time_modified"])
    if modified_through == series.modified_through:
        # Nothing stamped since the last sync. Re-reading the overlap anyway
        # would re-fetch a retired buoy's last reprocessing every hour.
        session.commit()
        return False
    span = erddap.rows(
        series.dataset_id,
        ["time"],
        [*since, f"time_modified<={format_time(modified_through)}", 'orderByMinMax("time")'],
    )
    first_day = parse_time(span[0]["time"]).date()
    last_day = parse_time(span[-1]["time"]).date()

    raw = erddap.dataset(
        series.dataset_id,
        VARIABLES,
        [f"time>={format_time(first_day)}", f"time<{format_time(last_day + dt.timedelta(days=1))}"],
    )
    daily = hobday.daily_means(raw) if raw is not None else pd.DataFrame(columns=["temperature", "hours"])

    session.execute(
        delete(DailyMean).where(DailyMean.series_id == series.id, DailyMean.date.between(first_day, last_day))
    )
    if not daily.empty:
        session.execute(
            insert(DailyMean),
            [
                {"series_id": series.id, "date": day.date(), "temperature": float(temp), "hours": int(hours)}
                for day, temp, hours in daily.itertuples()
            ],
        )
    series.modified_through = modified_through
    update_heatwaves(session, series)
    session.commit()
    log.info("%s: re-read %s to %s (%d days)", series.dataset_id, first_day, last_day, len(daily))
    return True


def update_heatwaves(session: Session, series: Series) -> None:
    """Recompute a series' climatology, events and latest status from its daily means."""
    rows = session.execute(
        select(DailyMean.date, DailyMean.temperature)
        .where(DailyMean.series_id == series.id)
        .order_by(DailyMean.date)
    ).all()
    if not rows:
        return
    temperature = pd.Series(
        [row.temperature for row in rows], index=pd.DatetimeIndex([row.date for row in rows])
    )

    try:
        stats = hobday.climatology(temperature, BASELINE)
    except hobday.InsufficientData as error:
        log.warning("%s: can't compute heatwaves: %s", series.dataset_id, error)
        return
    frame = hobday.align(temperature, stats)
    events = hobday.detect_events(frame)
    status = hobday.latest_status(frame)

    session.execute(delete(ClimatologyDay).where(ClimatologyDay.series_id == series.id))
    session.execute(
        insert(ClimatologyDay),
        [
            {
                "series_id": series.id,
                "day_of_year": int(day),
                "mean": float(mean),
                "threshold": float(threshold),
            }
            for day, mean, threshold in zip(
                stats["day_of_year"].values, stats["mean"].values, stats["threshold"].values, strict=True
            )
        ],
    )
    session.execute(delete(Event).where(Event.series_id == series.id))
    if events:
        session.execute(
            insert(Event),
            [
                {
                    "series_id": series.id,
                    "start_date": event.start,
                    "end_date": event.end,
                    "peak_date": event.peak,
                    "max_intensity": event.max_intensity,
                    "mean_intensity": event.mean_intensity,
                    "category": event.category,
                }
                for event in events
            ],
        )
    series.latest_date = status.date
    series.latest_temperature = status.temperature
    series.latest_climatology = status.climatology
    series.latest_threshold = status.threshold
    series.days_above = status.days_above


def sync_all(session_factory: sessionmaker, erddap: Erddap) -> int:
    """Sync every series, one at a time. Returns the number that failed."""
    with session_factory() as session:
        ensure_catalog(session, erddap)
        series_ids = session.scalars(select(Series.id).order_by(Series.buoy_id, Series.depth)).all()

    failures = 0
    for series_id in series_ids:
        with session_factory() as session:
            series = session.get_one(Series, series_id)
            try:
                if not sync_series(session, erddap, series):
                    log.info("%s: no new data", series.dataset_id)
            except Exception:
                # One bad series (an ERDDAP error, a baseline with too little
                # data) shouldn't stop the others from updating.
                session.rollback()
                log.exception("%s: sync failed", series.dataset_id)
                failures += 1
    return failures


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--every", type=float, metavar="SECONDS", help="keep running, syncing this often")
    parser.add_argument(
        "--recompute",
        action="store_true",
        help="recompute every series' heatwaves from stored data, without contacting ERDDAP "
        "(after a change to the method)",
    )
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)

    from heatwaves.db import SessionLocal

    if args.recompute:
        with SessionLocal() as session:
            for series in session.scalars(select(Series)):
                update_heatwaves(session, series)
                log.info("%s: recomputed", series.dataset_id)
            session.commit()
        return 0

    headers = {"User-Agent": settings.user_agent}
    with httpx.Client(timeout=settings.erddap_timeout, headers=headers, follow_redirects=True) as client:
        erddap = Erddap(settings.erddap_url, client)
        while True:
            try:
                failures = sync_all(SessionLocal, erddap)
            except httpx.HTTPError:
                if args.every is None:
                    raise
                log.exception("Sync round failed; retrying in %.0f s", args.every)
                failures = 1
            if args.every is None:
                return 1 if failures else 0
            time.sleep(args.every)


if __name__ == "__main__":
    sys.exit(main())
