"""Settings, read from the environment once at import."""

import datetime as dt
import os
from dataclasses import dataclass


@dataclass(frozen=True)
class Settings:
    database_url: str
    erddap_url: str
    erddap_timeout: float
    user_agent: str
    # /healthz fails once the last successful sync is older than this.
    sync_stale_after: dt.timedelta

    @classmethod
    def from_env(cls) -> Settings:
        env = os.environ.get
        return cls(
            database_url=env("DATABASE_URL", "sqlite:///gom-heatwaves.db"),
            erddap_url=env("ERDDAP_URL", "https://data.neracoos.org/erddap"),
            erddap_timeout=float(env("ERDDAP_TIMEOUT", "120")),
            user_agent=env(
                "ERDDAP_USER_AGENT", "gom-heatwaves/0.1 (+https://github.com/maxretter/gom-heatwaves)"
            ),
            sync_stale_after=dt.timedelta(hours=float(env("SYNC_STALE_AFTER_HOURS", "3"))),
        )


settings = Settings.from_env()
