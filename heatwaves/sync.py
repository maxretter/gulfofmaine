"""Bring the database up to date with ERDDAP, then recompute heatwaves.

    python -m heatwaves.sync              # once
    python -m heatwaves.sync --every 600  # every 10 minutes, until stopped

Kept running, most rounds check only the buoy datasets still reporting,
the only ones that get new readings within the hour; about once an hour, a
round checks everything (sync_all).

Each fetch covers every series in one dataset: all the variables of a
buoy's dataset, or every buoy's cell of the satellite grid. heatwaves.sources
says how each source finds what changed. Storing is the same for all of
them: the fetched days replace the stored ones, then each series' heatwaves
are recomputed from its full record. What changed goes out on the live feed
(heatwaves.live) when the transaction commits, and after a round that stored
anything the NetCDF and CSV products (heatwaves.products) are rewritten.
"""

import argparse
import datetime as dt
import logging
import sys
import time
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Literal

import httpx
import pandas as pd
from sqlalchemy import delete, func, insert, select, update
from sqlalchemy.orm import Session, sessionmaker

from heatwaves import hobday, live, origin, products, queries, state
from heatwaves.config import settings
from heatwaves.erddap import Erddap
from heatwaves.models import Buoy, ClimatologyDay, DailyMean, Event, Series
from heatwaves.sources import Download, Source, connect
from heatwaves.state import SeriesState
from heatwaves.stations import BASELINE, BUOYS, SERIES

log = logging.getLogger(__name__)

# What a sync of one fetch came to: new data stored, nothing new, or an error.
Outcome = Literal["updated", "unchanged", "failed"]

# A Postgres advisory lock held by whichever process is syncing (any number unique to this app).
SYNC_LOCK = 0x68656174
# How often, kept running, a round checks every series rather than only the buoys still reporting.
FULL_ROUND = dt.timedelta(hours=1)


def ensure_catalog(session: Session, erddap: Erddap) -> bool:
    """Create rows for every buoy and series in `stations`, with positions from ERDDAP.

    False if ERDDAP's catalog couldn't be read: the rows are made all the
    same, and the buoys keep the positions they had.
    """
    # Each buoy's position comes from its shallowest dataset.
    surface: dict[str, str] = {}  # dataset ID: buoy
    for spec in sorted(SERIES, key=lambda spec: spec.depth):
        if spec.source == "buoy" and spec.buoy not in surface.values():
            surface[spec.dataset_id] = spec.buoy
    try:
        positions = {
            surface[row["datasetID"]]: row for row in erddap.catalog(surface, ["minLatitude", "minLongitude"])
        }
    except Exception:
        # An error, or a web page in place of JSON while ERDDAP is down for maintenance.
        log.exception("Reading the buoys' positions from ERDDAP failed")
        positions = None
    one_sync_at_a_time(session)
    for code, name in BUOYS.items():
        buoy = session.get(Buoy, code) or Buoy(id=code)
        buoy.name = name
        if positions and code in positions:
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
    return positions is not None


def sync_series(session: Session, sources: Mapping[str, Source], series: Series) -> bool:
    """Fetch what changed in a series and the rest of its dataset, and store it.

    True if anything was read.
    """
    one_sync_at_a_time(session)
    together = session.scalars(
        select(Series)
        .where(Series.source == series.source, Series.dataset_id == series.dataset_id)
        .order_by(Series.id)
        # Another process may have synced them while this one waited.
        .execution_options(populate_existing=True)
    ).all()
    download = sources[series.source].fetch(together)
    synced_at = dt.datetime.now(dt.UTC)
    for each in together:
        each.synced_at = synced_at
    if download is not None:
        live.publish(session, store(session, together, download))
    session.commit()
    return download is not None


def one_sync_at_a_time(session: Session) -> None:
    """Wait until no other process is syncing, then keep it that way until this transaction ends.

    A one-off run (after a deploy, say) can overlap the scheduled job, and
    every sync rewrites every heatwave's origin. On Postgres only; SQLite
    allows one writer anyway.
    """
    if session.get_bind().dialect.name == "postgresql":
        session.execute(select(func.pg_advisory_xact_lock(SYNC_LOCK)))


def store(session: Session, series: Sequence[Series], download: Download) -> list[live.Message]:
    """Replace each series' daily means over the downloaded span, then recompute its heatwaves.

    Every heatwave's origin is then judged again, since the evidence for one
    comes from other series too. Returns the live feed's messages: each newer
    temperature reading, and each temperature series whose state changed or
    whose heatwave in progress grew or changed.
    """
    messages: list[live.Message] = []
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
        each.preliminary_from = download.preliminary_from
        reading = download.latest.get(each.id)
        stored_at = each.latest_reading_at
        newer = reading is not None and (stored_at is None or reading.time > stored_at)
        # A download that re-read the stored reading's day replaces it even
        # with an older reading, or none: quality control may have failed it since.
        reread = stored_at is not None and download.first_day <= stored_at.date() <= download.last_day
        if newer or reread:
            each.latest_reading_at = reading.time if reading else None
            each.latest_reading = reading.value if reading else None
            # Only a newer reading goes out on the live feed, which pages take as the latest.
            if newer and each.variable == "temperature":
                messages.append(live.reading_message(each))
        before, after = update_heatwaves(session, each)
        if each.variable == "temperature" and after != before:
            messages.append(live.status_message(each, before, after))
        log.info(
            "%s: re-read %s to %s (%d days)",
            each.label,
            download.first_day,
            download.last_day,
            len(daily),
        )
    update_origins(session)
    return messages


def update_heatwaves(session: Session, series: Series) -> tuple[SeriesState, SeriesState]:
    """Recompute a series' climatology, events and latest status from its daily means.

    Every variable gets a climatology, as its normal; only temperature gets
    events. A series with too little data in the baseline for a normal has
    neither, but still gets its newest day and value. Returns the series'
    state today, before and after.
    """
    today = dt.datetime.now(dt.UTC).date()
    before = state.current(session, series, today)
    rows = session.execute(
        select(DailyMean.date, DailyMean.value)
        .where(DailyMean.series_id == series.id)
        .order_by(DailyMean.date)
    ).all()
    if not rows:
        return before, before
    daily = pd.Series([row.value for row in rows], index=pd.DatetimeIndex([row.date for row in rows]))

    try:
        analysis = hobday.analyze(daily, BASELINE)
    except hobday.InsufficientData as error:
        log.warning("%s: can't compute heatwaves: %s", series.label, error)
        analysis = None

    session.execute(delete(ClimatologyDay).where(ClimatologyDay.series_id == series.id))
    session.execute(delete(Event).where(Event.series_id == series.id))
    if analysis is None:
        # The newest day still says whether the series is reporting, which
        # decides whether the quick rounds between full ones check it.
        series.latest_date, series.latest_value = rows[-1].date, rows[-1].value
        series.latest_climatology = series.latest_threshold = None
        series.days_above = 0
        return before, state.current(session, series, today)

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
    if analysis.events and series.variable == "temperature":
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
    return before, state.current(session, series, today)


def update_origins(session: Session) -> None:
    """Label every heatwave at the depths heatwaves.origin covers with where its heat likely came from."""
    record = queries.origin_record(session)
    events = session.execute(
        select(Event.id, Event.start_date, Series.buoy_id, Series.depth)
        .join(Series)
        .where(Series.source == "buoy", Series.variable == "temperature", Series.depth.in_(origin.DEPTHS))
    ).all()
    judged = [
        (event.id, origin.judge(record, event.buoy_id, event.depth, event.start_date)) for event in events
    ]
    if judged:
        session.execute(
            update(Event),
            [
                {"id": event_id, "origin": evidence.origin, "evidence": evidence.to_json()}
                for event_id, evidence in judged
            ],
        )


def sync_one(session_factory: sessionmaker, sources: Mapping[str, Source], series_id: int) -> Outcome:
    """Sync one series, and the others fetched with it, in a session of its own."""
    with session_factory() as session:
        series = session.get_one(Series, series_id)
        # Read now: after a rollback, reading it would query the database, which may be what failed.
        dataset_id = series.dataset_id
        try:
            if sync_series(session, sources, series):
                return "updated"
        except Exception:
            # One bad series (an ERDDAP error, a baseline with too little
            # data) shouldn't stop the others from updating.
            session.rollback()
            log.exception("%s: sync failed", dataset_id)
            return "failed"
        log.info("%s: no new data", dataset_id)
        return "unchanged"


def publish(session_factory: sessionmaker, directory: Path) -> None:
    """Rewrite the NetCDF and CSV products from the stored record (heatwaves.products)."""
    started = time.monotonic()
    try:
        with session_factory() as session:
            products.write(session, directory)
    except Exception:
        # The stored record is up to date; the files catch up after the next round that stores something.
        log.exception("Writing the products to %s failed", directory)
        return
    log.info("Wrote the products to %s in %.1f s", directory, time.monotonic() - started)


def sync_all(
    session_factory: sessionmaker,
    erddap: Erddap,
    sources: Mapping[str, Source],
    everything: bool = True,
    products_dir: Path | None = None,
) -> int:
    """Sync series, one fetch at a time. Returns the number of fetches that failed.

    Without `everything`, only the buoy datasets still reporting (not
    offline): all that gets new readings within the hour. The satellite adds
    a day once a day, and a retired buoy's data changes only when it's
    reprocessed. `erddap` is the NERACOOS server, which lists the buoys'
    positions; when it can't, that counts as a failed fetch and the round
    goes on.

    The products in `products_dir`, if given, are rewritten at the end when
    anything new was stored, or when there are none yet: once a round, as
    a rewrite takes several seconds.
    """
    failures = 0
    with session_factory() as session:
        if everything and not ensure_catalog(session, erddap):
            failures += 1
        # One series from each fetch; sync_one brings the rest along.
        query = (
            select(func.min(Series.id))
            .group_by(Series.source, Series.dataset_id)
            # "buoy" before "satellite", so the satellite's first backfill doesn't hold the buoys up.
            .order_by(Series.source, Series.dataset_id)
        )
        if not everything:
            reporting_since = dt.datetime.now(dt.UTC).date() - state.OFFLINE_AFTER
            query = query.where(Series.source == "buoy", Series.latest_date >= reporting_since)
        series_ids = session.scalars(query).all()
    outcomes = [sync_one(session_factory, sources, series_id) for series_id in series_ids]
    if products_dir is not None and ("updated" in outcomes or not products.listing(products_dir)):
        publish(session_factory, products_dir)
    return failures + outcomes.count("failed")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--every",
        type=float,
        metavar="SECONDS",
        help="keep running, a round this often; about hourly, a round checks everything",
    )
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
            one_sync_at_a_time(session)
            for series in session.scalars(select(Series)):
                update_heatwaves(session, series)
                log.info("%s: recomputed", series.label)
            update_origins(session)
            session.commit()
        publish(SessionLocal, settings.products_dir)
        return 0

    headers = {"User-Agent": settings.user_agent}
    with httpx.Client(timeout=settings.erddap_timeout, headers=headers, follow_redirects=True) as client:
        erddap = Erddap(settings.erddap_url, client)
        sources = connect(client)
        full_every = max(1, round(FULL_ROUND.total_seconds() / args.every)) if args.every else 1
        quick_rounds = 0  # left before the next full round
        while True:
            everything = quick_rounds == 0
            # Counted whether or not the round succeeds, so failing rounds don't all check everything.
            quick_rounds = full_every - 1 if everything else quick_rounds - 1
            try:
                failures = sync_all(SessionLocal, erddap, sources, everything, settings.products_dir)
            except Exception:
                if args.every is None:
                    raise
                # ERDDAP, the database or anything else: exiting would have the
                # container restarted straight into a full round.
                log.exception("Sync round failed; retrying in %.0f s", args.every)
                failures = 1
            if args.every is None:
                return 1 if failures else 0
            time.sleep(args.every)


if __name__ == "__main__":
    sys.exit(main())
