"""Bring the database up to date with ERDDAP, then recompute heatwaves.

    python -m heatwaves.sync              # once
    python -m heatwaves.sync --every 600  # every 10 minutes, until stopped

Kept running, most rounds check only the buoy datasets still reporting,
the only ones that get new readings within the hour; about once an hour,
and whenever the database holds no series, a round checks everything
(sync_all).

Each fetch covers every series in one dataset: all the variables of a
buoy's dataset, or every buoy's cell of the satellite grid. heatwaves.sources
says how each source finds what changed. Storing is the same for all of
them: the fetched days replace the stored ones, then each series' heatwaves
are recomputed from its full record, and each heatwave whose origin rests
on the changed days is judged again. What changed goes out on the live
feed (heatwaves.live) when the transaction commits, and at the end of a
round the NetCDF and CSV products (heatwaves.products) of each buoy depth
it changed are rewritten.
"""

import argparse
import datetime as dt
import logging
import sys
import time
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

import httpx
import pandas as pd
import xarray as xr
from sqlalchemy import Row, delete, func, insert, select, update
from sqlalchemy.orm import Session, sessionmaker

from heatwaves import hobday, live, origin, products, queries, state
from heatwaves.config import settings
from heatwaves.erddap import Erddap, same_origin
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

# The days a series' normal is computed from: the baseline years, and the days
# either side whose values can fill a short gap at its ends (hobday.climatology).
NORMAL_DAYS = (
    dt.date(BASELINE[0], 1, 1) - dt.timedelta(days=hobday.MAX_PAD),
    dt.date(BASELINE[1], 12, 31) + dt.timedelta(days=hobday.MAX_PAD),
)

# Days of the record that changed at a buoy and depth, in any variable: (buoy, depth, first, last).
Change = tuple[str, int, dt.date, dt.date]


def now() -> dt.datetime:
    """The time the sync goes by, as api.now is the API's; tests stop it."""
    return dt.datetime.now(dt.UTC)


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
    synced_at = now()
    for each in together:
        each.synced_at = synced_at
    if download is not None:
        live.publish(session, store(session, together, download))
    session.commit()
    return download is not None


def one_sync_at_a_time(session: Session) -> None:
    """Wait until no other process is syncing, then keep it that way until this transaction ends.

    A one-off run (after a deploy, say) can overlap the scheduled job, and a
    sync rewrites the origins of heatwaves at other buoys too. On Postgres
    only; SQLite allows one writer anyway.
    """
    if session.get_bind().dialect.name == "postgresql":
        session.execute(select(func.pg_advisory_xact_lock(SYNC_LOCK)))


def store(session: Session, series: Sequence[Series], download: Download) -> list[live.Message]:
    """Replace each series' daily means over the downloaded span, then recompute its heatwaves.

    Each heatwave whose origin rests on the changed days, at any buoy since
    the evidence for one comes from other series too, is then judged again.
    Returns the live feed's messages: each newer temperature reading, each
    temperature series whose state changed or whose heatwave in progress
    grew or changed, and the heatwaves whose origin or its evidence did.
    """
    messages: list[live.Message] = []
    changed: list[Change] = []
    new_normal = download.first_day <= NORMAL_DAYS[1] and download.last_day >= NORMAL_DAYS[0]
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
        updated = update_heatwaves(session, each, new_normal)
        if each.variable == "temperature" and updated.after != updated.before:
            messages.append(live.status_message(each, updated.before, updated.after))
        changed += [
            (each.buoy_id, each.depth, first, last)
            for first, last in [(download.first_day, download.last_day), *updated.changed]
        ]
        log.info(
            "%s: re-read %s to %s (%d days)",
            each.label,
            download.first_day,
            download.last_day,
            len(daily),
        )
    messages += live.origins_messages(update_origins(session, changed))
    return messages


# Why each series this process has tried couldn't get a normal, by series ID. Each store tries
# again, with the same outcome until days of the baseline change, so a reason is a warning only
# the first time a series has it, and after it has had a normal since.
_no_normal: dict[int, str] = {}


@dataclass(frozen=True)
class Updated:
    """What update_heatwaves did to a series."""

    before: SeriesState  # its state today
    after: SeriesState
    # Spans of days, first to last, whose anomalies or heatwave days it may have changed: every
    # day when it computed the normal or dropped one, else those of each heatwave it added or removed.
    changed: list[tuple[dt.date, dt.date]]


def update_heatwaves(session: Session, series: Series, new_normal: bool = True) -> Updated:
    """Recompute a series' events and latest status from its daily means, and its climatology.

    Every variable gets a climatology, as its normal; only temperature gets
    events. Without `new_normal`, the stored climatology stands: the same
    as one computed anew while none of NORMAL_DAYS has changed. A series
    with too little data in the baseline for a normal has neither, but still
    gets its newest day and value; one with no daily means left has none of
    these. Heatwaves found again as they were keep their rows, and with them
    their origin.
    """
    today = now().date()
    before = state.current(session, series, today)
    rows = session.execute(
        select(DailyMean.date, DailyMean.value)
        .where(DailyMean.series_id == series.id)
        .order_by(DailyMean.date)
    ).all()
    if not rows:
        # Every daily mean is gone, deleted upstream: so is all that was derived from them.
        session.execute(delete(ClimatologyDay).where(ClimatologyDay.series_id == series.id))
        changed = _replace_events(session, series, [])
        series.latest_date = series.latest_value = None
        series.latest_climatology = series.latest_threshold = None
        series.days_above = 0
        return Updated(before, state.current(session, series, today), changed)
    daily = pd.Series([row.value for row in rows], index=pd.DatetimeIndex([row.date for row in rows]))

    stored = _stored_normal(session, series)
    normal = None if new_normal else stored
    changed: list[tuple[dt.date, dt.date]] = []
    if normal is None:
        session.execute(delete(ClimatologyDay).where(ClimatologyDay.series_id == series.id))
        try:
            normal = hobday.climatology(daily, BASELINE)
        except hobday.InsufficientData as error:
            known = _no_normal.get(series.id) == str(error)
            _no_normal[series.id] = str(error)
            log.log(
                logging.DEBUG if known else logging.WARNING,
                "%s: can't compute heatwaves: %s",
                series.label,
                error,
            )
        else:
            _no_normal.pop(series.id, None)
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
                        normal["day_of_year"].values,
                        normal["mean"].values,
                        normal["threshold"].values,
                        strict=True,
                    )
                ],
            )
        # A normal computed or dropped changes every day's anomaly; still without one, none changed.
        if normal is not None or stored is not None:
            changed.append((rows[0].date, rows[-1].date))

    frame = hobday.align(daily, normal) if normal is not None else None
    events = hobday.detect_events(frame) if frame is not None and series.variable == "temperature" else []
    changed += _replace_events(session, series, events)
    if frame is None:
        # The newest day still says whether the series is reporting, which
        # decides whether the quick rounds between full ones check it.
        series.latest_date, series.latest_value = rows[-1].date, rows[-1].value
        series.latest_climatology = series.latest_threshold = None
        series.days_above = 0
        return Updated(before, state.current(session, series, today), changed)

    status = hobday.latest_status(frame)
    series.latest_date = status.date
    series.latest_value = status.temperature
    series.latest_climatology = status.climatology
    series.latest_threshold = status.threshold
    series.days_above = status.days_above
    return Updated(before, state.current(session, series, today), changed)


def _stored_normal(session: Session, series: Series) -> xr.Dataset | None:
    """A series' stored climatology, as hobday.climatology returns it; None if it has none."""
    rows = session.execute(
        select(ClimatologyDay.day_of_year, ClimatologyDay.mean, ClimatologyDay.threshold)
        .where(ClimatologyDay.series_id == series.id)
        .order_by(ClimatologyDay.day_of_year)
    ).all()
    if not rows:
        return None
    return xr.Dataset(
        {
            "mean": ("day_of_year", [row.mean for row in rows]),
            "threshold": ("day_of_year", [row.threshold for row in rows]),
        },
        coords={"day_of_year": [row.day_of_year for row in rows]},
    )


def _replace_events(
    session: Session, series: Series, events: Sequence[hobday.Event]
) -> list[tuple[dt.date, dt.date]]:
    """Store a series' heatwaves in place of its old ones. Returns the span of each one added or removed.

    One found again with the same dates, intensities and category keeps its row.
    """
    stored = {
        tuple(row[1:]): row.id
        for row in session.execute(
            select(
                Event.id,
                Event.start_date,
                Event.end_date,
                Event.peak_date,
                Event.max_intensity,
                Event.mean_intensity,
                Event.category,
            ).where(Event.series_id == series.id)
        )
    }
    found = {
        (event.start, event.end, event.peak, event.max_intensity, event.mean_intensity, event.category): event
        for event in events
    }
    gone = [key for key in stored if key not in found]
    new = [event for key, event in found.items() if key not in stored]
    if gone:
        session.execute(delete(Event).where(Event.id.in_([stored[key] for key in gone])))
    if new:
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
                for event in new
            ],
        )
    return [(start, end) for start, end, *_ in gone] + [(event.start, event.end) for event in new]


def update_origins(session: Session, changed: Collection[Change] | None = None) -> list[live.JudgedHeatwave]:
    """Label heatwaves at the depths heatwaves.origin covers with where their heat likely came from.

    Every one, or with `changed`, those not labeled yet and those whose
    evidence a changed span of the record falls in. Returns those whose
    label or evidence came out different, for the live feed.
    """
    events = session.execute(
        select(
            Event.id,
            Event.start_date,
            Event.end_date,
            Event.origin,
            Event.evidence,
            Series.buoy_id,
            Series.depth,
        )
        .join(Series)
        .where(Series.source == "buoy", Series.variable == "temperature", Series.depth.in_(origin.DEPTHS))
    ).all()
    if changed is not None:
        events = [event for event in events if event.origin is None or _rests_on(event, changed)]
    if not events:
        return []
    windows = [origin.window(event.start_date) for event in events]
    record = queries.origin_record(
        session,
        min(first for first, _ in windows),
        max(last for _, last in windows),
        around={(event.buoy_id, event.depth) for event in events},
    )
    judged = [origin.judge(record, event.buoy_id, event.depth, event.start_date) for event in events]
    session.execute(
        update(Event),
        [
            {"id": event.id, "origin": evidence.origin, "evidence": evidence.to_json()}
            for event, evidence in zip(events, judged, strict=True)
        ],
    )
    return [
        live.JudgedHeatwave(buoy=event.buoy_id, depth=event.depth, start=event.start_date, end=event.end_date)
        for event, evidence in zip(events, judged, strict=True)
        if (evidence.origin, evidence.to_json()) != (event.origin, event.evidence)
    ]


def _rests_on(event: Row, changed: Collection[Change]) -> bool:
    """Whether a changed span of the record is among what judging a heatwave reads."""
    inputs = origin.inputs(event.buoy_id, event.depth)
    first, last = origin.window(event.start_date)
    return any(
        (buoy, depth) in inputs and start <= last and end >= first for buoy, depth, start, end in changed
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


# The daily files, by buoy and depth, this process has yet to write to each products directory
# since their data changed. Until a write to a directory succeeds, every one: a process stopped
# between storing and writing may have left any behind, and code deployed since may write them
# differently. So too after a round that failed partway (sync_all).
_unwritten: dict[Path, set[tuple[str, int]]] = {}


def publish(
    session_factory: sessionmaker, directory: Path, changed: Collection[tuple[str, int]] | None = None
) -> bool:
    """Rewrite the NetCDF and CSV products from the stored record (heatwaves.products).

    Every daily file, or those `changed`, by buoy and depth, with any still
    unwritten; and the events each time. False if the write failed.
    """
    unwritten = _unwritten.get(directory)
    depths = None if changed is None or unwritten is None else unwritten | set(changed)
    if depths is not None:
        _unwritten[directory] = depths
    started = time.monotonic()
    try:
        with session_factory() as session:
            products.write(session, directory, depths)
    except Exception:
        # The stored record is up to date; the files are left for the next write (_unwritten).
        log.exception("Writing the products to %s failed", directory)
        return False
    _unwritten[directory] = set()
    log.info(
        "Wrote the products to %s in %.1f s (%s)",
        directory,
        time.monotonic() - started,
        "every file" if depths is None else f"{len(depths)} buoy depths, and the events",
    )
    return True


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
    reprocessed. While the database holds no series, every round checks
    everything. `erddap` is the NERACOOS server, which lists the buoys'
    positions; when it can't, that counts as a failed fetch and the round
    goes on.

    The products in `products_dir`, if given, are rewritten at the end,
    once a round: the files of each buoy depth the round changed and any
    left unwritten (every one, at a process's first round or after one that
    failed partway, see `publish`), and the events. A write that fails
    counts as one failed fetch more, as the files left may not match the
    stored record.
    """
    failures = 0
    try:
        with session_factory() as session:
            before = products.extras(session) if products_dir is not None else {}
            # A new database, as after a Postgres upgrade, holds no series for a quick round to check.
            everything = everything or session.scalar(select(Series.id).limit(1)) is None
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
                reporting_since = now().date() - state.OFFLINE_AFTER
                query = query.where(Series.source == "buoy", Series.latest_date >= reporting_since)
            series_ids = session.scalars(query).all()
        outcomes = [sync_one(session_factory, sources, series_id) for series_id in series_ids]
        if products_dir is None:
            return failures + outcomes.count("failed")
        stored = [
            series_id for series_id, outcome in zip(series_ids, outcomes, strict=True) if outcome == "updated"
        ]
        with session_factory() as session:
            changed = _changed_files(session, stored, before)
    except Exception:
        # The round may have stored data, or moved a buoy, before it failed, and
        # can't say whose files that changed: the next write is of every file.
        if products_dir is not None:
            _unwritten.pop(products_dir, None)
        raise
    # Any left unwritten too: every file, at a process's first round.
    due = bool(changed) or _unwritten.get(products_dir) != set() or not products.listing(products_dir)
    if due and not publish(session_factory, products_dir, changed):
        failures += 1
    return failures + outcomes.count("failed")


def _changed_files(
    session: Session, stored: Collection[int], before: Mapping[tuple[str, int], object]
) -> set[tuple[str, int]]:
    """The daily files whose contents a round changed, by buoy and depth.

    Those of each dataset `stored` (one series ID from each), each file at a
    buoy for its satellite series, which every depth's file holds, and those
    whose products.extras differ from `before`.
    """
    after = products.extras(session)
    changed = {key for key, extras in after.items() if extras != before.get(key)}
    datasets = session.execute(select(Series.source, Series.dataset_id).where(Series.id.in_(stored))).all()
    for source, dataset_id in datasets:
        for buoy_id, depth in session.execute(
            select(Series.buoy_id, Series.depth).where(
                Series.source == source, Series.dataset_id == dataset_id
            )
        ):
            changed |= {
                key for key in after if key[0] == buoy_id and (source == "satellite" or key[1] == depth)
            }
    return changed


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
        # Files left as they were don't match what was recomputed, and the sync job doesn't know to
        # rewrite them: failing says so.
        return 0 if publish(SessionLocal, settings.products_dir) else 1

    headers = {"User-Agent": settings.user_agent}
    with httpx.Client(
        # Per step, such as each read; Erddap limits each request's whole time and its size.
        timeout=settings.erddap_timeout,
        headers=headers,
        # Within an origin only, and by each request's deadline (same_origin).
        follow_redirects=True,
        event_hooks={"response": [same_origin]},
    ) as client:
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
    products.stop_on_sigterm()
    sys.exit(main())
