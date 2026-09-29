"""Settings, read from the environment once at import."""

import datetime as dt
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Settings:
    database_url: str
    erddap_url: str  # NERACOOS, for the buoys
    coastwatch_url: str  # NOAA CoastWatch, for satellite sea surface temperature
    erddap_timeout: float
    user_agent: str
    # /healthz fails once the last successful sync is older than this.
    sync_stale_after: dt.timedelta
    # Browsers the live feed serves at once (heatwaves.live).
    live_max_clients: int
    # Where the sync job writes the NetCDF and CSV products (heatwaves.products) and the API reads them.
    products_dir: Path

    @classmethod
    def from_env(cls) -> Settings:
        env = os.environ.get
        return cls(
            database_url=env("DATABASE_URL", "sqlite:///gom-heatwaves.db"),
            erddap_url=env("ERDDAP_URL", "https://data.neracoos.org/erddap"),
            coastwatch_url=env("COASTWATCH_URL", "https://coastwatch.pfeg.noaa.gov/erddap"),
            erddap_timeout=float(env("ERDDAP_TIMEOUT", "120")),
            user_agent=env(
                "ERDDAP_USER_AGENT", "gom-heatwaves/0.1 (+https://github.com/maxretter/gulfofmaine)"
            ),
            sync_stale_after=dt.timedelta(hours=float(env("SYNC_STALE_AFTER_HOURS", "3"))),
            live_max_clients=int(env("LIVE_MAX_CLIENTS") or "200"),
            products_dir=Path(env("PRODUCTS_DIR", "products")),
        )


settings = Settings.from_env()
