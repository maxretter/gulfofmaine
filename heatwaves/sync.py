"""Bring the database up to date with ERDDAP, then recompute heatwaves.

    python -m heatwaves.sync               # once
    python -m heatwaves.sync --every 3600  # hourly, until stopped

Each fetch covers every series in one dataset: all the variables of a
buoy's dataset, or every buoy's cell of the satellite grid. heatwaves.sources
says how each source finds what changed. Storing is the same for all of
them: the fetched days replace the stored ones, then each series' heatwaves
are recomputed from its full record.
"""

import argparse
import datetime as dt
import logging
import sys
import time
from collections.abc import Mapping, Sequence

import httpx
import pandas as pd
from sqlalchemy import delete, func, insert, select
from sqlalchemy.orm import Session, sessionmaker

from heatwaves import hobday
from heatwaves.config import settings
from heatwaves.erddap import Erddap
from heatwaves.models import Buoy, ClimatologyDay, DailyMean, Event, Series
from heatwaves.sources import Download, Source, connect
from heatwaves.stations import BASELINE, BUOYS, SERIES

log = logging.getLogger(__name__)


def ensure_catalog(session: Session, erddap: Erddap) -> None:
    """Create rows for every buoy and series in `stations`, with positions from ERDDAP."""
    # Each buoy's position comes from its shallowest dataset.
    surface: dict[str, str] = {}  # dataset ID: buoy
    for spec in sorted(SERIES, key=lambda spec: spec.depth):
        if spec.source == "buoy" and spec.buoy not in surface.values():
            surface[spec.dataset_id] = spec.buoy
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
    for spec in SERIES:
        series = session.scalar(
            select(Series).where(
                Series.buoy_id == spec.buoy,
                Series.depth == spec.depth,
                Series.variable == spec.variable,
                Series.source == spec.source,
            )
        )
        if series is None:
            series = Series(buoy_id=spec.buoy, depth=spec.depth, variable=spec.variable, source=spec.source)
            session.add(series)
        series.dataset_id = spec.dataset_id
    session.commit()


def sync_series(session: Session, sources: Mapping[str, Source], series: Series) -> bool:
    """Fetch what changed in a series and the rest of its dataset, and store it.

    True if anything was read.
    """
    together = session.scalars(
        select(Series)
        .where(Series.source == series.source, Series.dataset_id == series.dataset_id)
        .order_by(Series.id)
    ).all()
    download = sources[series.source].fetch(together)
    synced_at = dt.datetime.now(dt.UTC)
    for each in together:
        each.synced_at = synced_at
    if download is not None:
        store(session, together, download)
    session.commit()
    return download is not None


def store(session: Session, series: Sequence[Series], download: Download) -> None:
    """Replace each series' daily means over the downloaded span, then recompute its heatwaves."""
    for each in series:
        daily = download.daily[each.id]
        session.execute(
            delete(DailyMean).where(
                DailyMean.series_id == each.id,
                DailyMean.date.between(download.first_day, download.last_day),
            )
        )
        if not daily.empty:
            session.execute(
                insert(DailyMean),
                [
                    {
                        "series_id": each.id,
                        "date": day.date(),
                        "value": float(value),
                        "hours": None if pd.isna(hours) else int(hours),
                    }
                    for day, value, hours in daily.itertuples()
                ],
            )
        each.modified_through = download.modified_through
        update_heatwaves(session, each)
        log.info(
            "%s: re-read %s to %s (%d days)",
            each.label,
            download.first_day,
            download.last_day,
            len(daily),
        )


def update_heatwaves(session: Session, series: Series) -> None:
    """Recompute a series' climatology, events and latest status from its daily means."""
    rows = session.execute(
        select(DailyMean.date, DailyMean.value)
        .where(DailyMean.series_id == series.id)
        .order_by(DailyMean.date)
    ).all()
    if not rows:
        return
    daily = pd.Series([row.value for row in rows], index=pd.DatetimeIndex([row.date for row in rows]))

    try:
        analysis = hobday.analyse(daily, BASELINE)
    except hobday.InsufficientData as error:
        log.warning("%s: can't compute heatwaves: %s", series.label, error)
        return

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
                analysis.climatology["day_of_year"].values,
                analysis.climatology["mean"].values,
                analysis.climatology["threshold"].values,
                strict=True,
            )
        ],
    )
    session.execute(delete(Event).where(Event.series_id == series.id))
    if analysis.events:
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
                for event in analysis.events
            ],
        )
    status = analysis.status
    series.latest_date = status.date
    series.latest_value = status.temperature
    series.latest_climatology = status.climatology
    series.latest_threshold = status.threshold
    series.days_above = status.days_above


def sync_one(session_factory: sessionmaker, sources: Mapping[str, Source], series_id: int) -> bool:
    """Sync one series, and the others fetched with it, in a session of its own. False if it failed."""
    with session_factory() as session:
        series = session.get_one(Series, series_id)
        try:
            if not sync_series(session, sources, series):
                log.info("%s: no new data", series.dataset_id)
        except Exception:
            # One bad series (an ERDDAP error, a baseline with too little
            # data) shouldn't stop the others from updating.
            session.rollback()
            log.exception("%s: sync failed", series.dataset_id)
            return False
    return True


def sync_all(session_factory: sessionmaker, erddap: Erddap, sources: Mapping[str, Source]) -> int:
    """Sync every series, one fetch at a time. Returns the number of fetches that failed.

    `erddap` is the NERACOOS server, which lists the buoys' positions.
    """
    with session_factory() as session:
        ensure_catalog(session, erddap)
        # One series from each fetch; sync_one brings the rest along.
        series_ids = session.scalars(
            select(func.min(Series.id))
            .group_by(Series.source, Series.dataset_id)
            # "buoy" before "satellite", so the satellite's first backfill doesn't hold the buoys up.
            .order_by(Series.source, Series.dataset_id)
        ).all()
    return sum(not sync_one(session_factory, sources, series_id) for series_id in series_ids)


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
                log.info("%s: recomputed", series.label)
            session.commit()
        return 0

    headers = {"User-Agent": settings.user_agent}
    with httpx.Client(timeout=settings.erddap_timeout, headers=headers, follow_redirects=True) as client:
        erddap = Erddap(settings.erddap_url, client)
        sources = connect(client)
        while True:
            try:
                failures = sync_all(SessionLocal, erddap, sources)
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
