"""One version: heatwaves.__version__, which the API and the sync's User-Agent send, and pyproject.toml and
the frontend's package.json state."""

import json
import tomllib
from pathlib import Path

from heatwaves import __version__
from heatwaves.config import Settings

ROOT = Path(__file__).resolve().parent.parent


def test_pyproject_and_the_frontend_have_the_package_version():
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text())
    package = json.loads((ROOT / "frontend" / "package.json").read_text())

    assert pyproject["project"]["version"] == package["version"] == __version__


def test_the_api_and_the_sync_send_it(client, monkeypatch):
    monkeypatch.delenv("ERDDAP_USER_AGENT", raising=False)

    assert client.get("/openapi.json").json()["info"]["version"] == __version__
    assert Settings.from_env().user_agent.startswith(f"gom-heatwaves/{__version__} ")
