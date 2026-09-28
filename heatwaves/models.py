"""Database tables.

DailyMean holds the observations; everything else about a series (its
climatology, events and latest status) is derived from them by
heatwaves.sync and rewritten whenever they change.
"""

import datetime as dt

from sqlalchemy import DateTime, ForeignKey, String, TypeDecorator, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship

from heatwaves.hobday import CATEGORIES


class UTCDateTime(TypeDecorator):
    """A timezone-aware datetime on every backend; SQLite would drop the zone."""

    impl = DateTime(timezone=True)
    cache_ok = True

    def process_result_value(self, value: dt.datetime | None, dialect) -> dt.datetime | None:
        if value is not None and value.tzinfo is None:
            value = value.replace(tzinfo=dt.UTC)
        return value


class Base(DeclarativeBase):
    pass


class Buoy(Base):
    __tablename__ = "buoy"

    id: Mapped[str] = mapped_column(String(8), primary_key=True)  # NERACOOS site code, e.g. A01
    name: Mapped[str]
    latitude: Mapped[float | None]
    longitude: Mapped[float | None]

    series: Mapped[list[Series]] = relationship(back_populates="buoy", order_by="Series.depth")


class Series(Base):
    """One variable at one depth on one buoy, from one source (see heatwaves.stations).

    Series at the same buoy, depth and source are fetched together, in one
    request for all their variables.
    """

    __tablename__ = "series"
    __table_args__ = (UniqueConstraint("buoy_id", "depth", "variable", "source"),)

    id: Mapped[int] = mapped_column(primary_key=True)
    buoy_id: Mapped[str] = mapped_column(ForeignKey("buoy.id"))
    depth: Mapped[int]  # metres
    variable: Mapped[str]  # e.g. temperature
    source: Mapped[str]  # e.g. buoy
    dataset_id: Mapped[str]

    # Newest ERDDAP time_modified already read; the next sync starts from here.
    modified_through: Mapped[dt.datetime | None] = mapped_column(UTCDateTime)
    synced_at: Mapped[dt.datetime | None] = mapped_column(UTCDateTime)

    # Conditions on the most recent day with data.
    latest_date: Mapped[dt.date | None]
    latest_value: Mapped[float | None]
    latest_climatology: Mapped[float | None]
    latest_threshold: Mapped[float | None]
    days_above: Mapped[int] = mapped_column(default=0)

    buoy: Mapped[Buoy] = relationship(back_populates="series")


class DailyMean(Base):
    __tablename__ = "daily_mean"

    series_id: Mapped[int] = mapped_column(ForeignKey("series.id", ondelete="CASCADE"), primary_key=True)
    date: Mapped[dt.date] = mapped_column(primary_key=True)
    value: Mapped[float]  # in the variable's units: degrees C for temperature
    hours: Mapped[int]  # hourly bins behind the mean


class ClimatologyDay(Base):
    __tablename__ = "climatology_day"

    series_id: Mapped[int] = mapped_column(ForeignKey("series.id", ondelete="CASCADE"), primary_key=True)
    day_of_year: Mapped[int] = mapped_column(primary_key=True)  # 1-366, Feb 29 = 60
    mean: Mapped[float]
    threshold: Mapped[float]


class Event(Base):
    __tablename__ = "event"

    id: Mapped[int] = mapped_column(primary_key=True)
    series_id: Mapped[int] = mapped_column(ForeignKey("series.id", ondelete="CASCADE"), index=True)
    start_date: Mapped[dt.date]
    end_date: Mapped[dt.date]  # inclusive
    peak_date: Mapped[dt.date]
    max_intensity: Mapped[float]  # degrees C above climatology
    mean_intensity: Mapped[float]
    category: Mapped[int]  # 1-4

    series: Mapped[Series] = relationship()

    @property
    def duration(self) -> int:
        return (self.end_date - self.start_date).days + 1

    @property
    def category_name(self) -> str:
        return CATEGORIES[self.category]
