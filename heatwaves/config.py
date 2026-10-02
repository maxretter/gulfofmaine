"""Settings, read from the environment once at import."""

import datetime as dt
import os
from dataclasses import dataclass
from pathlib import Path

from heatwaves import __version__


@dataclass(frozen=True)
class Settings:
    database_url: str
    erddap_url: str  # NERACOOS, for the buoys
    coastwatch_url: str  # NOAA CoastWatch, for satellite sea surface temperature
    erddap_timeout: float
    user_agent: str
    # /healthz fails once no buoy still reporting has synced within this, and lists any series that hasn't.
    sync_stale_after: dt.timedelta
    # Browsers the live feed serves at once (heatwaves.live).
    live_max_clients: int
    # Of those, from any one address. Room for several people with a few tabs each behind one
    # school's or office's address; one client can still hold no more than a tenth of the default 200.
    live_max_per_address: int
    # Origins besides the site's own whose pages may open the live feed, such as https://example.org.
    live_origins: frozenset[str]
    # The Host headers the site is reached by, with any port, such as example.org or localhost:8000.
    # If set, only pages there count as the site's own on the live feed; by default, a page at any.
    live_hosts: frozenset[str]
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
                "ERDDAP_USER_AGENT",
                f"gom-heatwaves/{__version__} (+https://github.com/maxretter/gulfofmaine)",
            ),
            sync_stale_after=dt.timedelta(hours=float(env("SYNC_STALE_AFTER_HOURS", "3"))),
            live_max_clients=int(env("LIVE_MAX_CLIENTS") or "200"),
            live_max_per_address=int(env("LIVE_MAX_PER_ADDRESS") or "20"),
            live_origins=frozenset(
                origin.strip().rstrip("/").lower()
                for origin in env("LIVE_ORIGINS", "").split(",")
                if origin.strip()
            ),
            live_hosts=frozenset(
                host.strip().lower() for host in env("LIVE_HOSTS", "").split(",") if host.strip()
            ),
            products_dir=Path(env("PRODUCTS_DIR", "products")),
        )


settings = Settings.from_env()
