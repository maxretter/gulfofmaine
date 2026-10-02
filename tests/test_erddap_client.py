"""The limits on what the ERDDAP client fetches (heatwaves.erddap), and how the sync job sets them up."""

import time
from collections.abc import Callable, Iterator

import httpx
import pytest

from heatwaves import sync
from heatwaves.erddap import Erddap
from tests.conftest import DATA, NO_MATCH


class Endless(httpx.SyncByteStream):
    """A response body that never ends: a chunk every `pause` seconds."""

    def __init__(self, pause: float) -> None:
        self.pause = pause

    def __iter__(self) -> Iterator[bytes]:
        while True:
            time.sleep(self.pause)
            yield b"\0" * 2**16


def endless(pause: float = 0.0) -> Erddap:
    """An ERDDAP that answers every request with an endless body."""
    transport = httpx.MockTransport(lambda request: httpx.Response(200, stream=Endless(pause)))
    return Erddap("https://data.neracoos.org/erddap", httpx.Client(transport=transport))


def test_a_response_is_read_only_up_to_a_cap(monkeypatch):
    monkeypatch.setattr(Erddap, "MAX_NETCDF", 4 * 2**20)  # rather than writing 256 MB here

    with pytest.raises(ValueError, match="sent more than 4,194,304 bytes"):
        endless().dataset("A01_ocean_001m", ["time", "temperature"])
    # A table's cap is much smaller.
    with pytest.raises(ValueError, match="sent more than 1,048,576 bytes"):
        endless().rows("A01_ocean_001m", ["time_modified"])


def test_a_request_has_a_deadline_however_steadily_it_reads(monkeypatch):
    monkeypatch.setattr(Erddap, "DEADLINE", 0.1)

    # Each chunk comes well within the client's timeout, but they don't stop.
    with pytest.raises(TimeoutError, match="took longer than"):
        endless(pause=0.02).rows("A01_ocean_001m", ["time_modified"])


def with_the_sync_jobs_client(
    monkeypatch,
    session_factory,
    respond: Callable[[httpx.Request], httpx.Response],
    check: Callable[[Erddap], None],
) -> None:
    """Run `check` on the sync job's own client, set up as the job sets it up, but answered by `respond`."""

    def sync_all(session_factory, erddap, sources, everything, products_dir):
        check(erddap)
        return 0

    client, transport = httpx.Client, httpx.MockTransport(respond)
    monkeypatch.setattr(httpx, "Client", lambda **kwargs: client(transport=transport, **kwargs))
    monkeypatch.setattr("heatwaves.db.SessionLocal", session_factory)
    monkeypatch.setattr(sync, "sync_all", sync_all)

    assert sync.main([]) == 0


def test_the_sync_job_follows_redirects_only_within_an_origin(monkeypatch, session_factory):
    requested: list[str] = []
    elsewhere = {
        "elsewhere": "https://erddap.example.com/erddap/x.json",
        "insecure": "http://data.neracoos.org/erddap/tabledap/A01_ocean_001m.json",
        "port": "https://data.neracoos.org:8443/erddap/tabledap/A01_ocean_001m.json",
    }

    def neracoos(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url.copy_with(query=None)))
        if request.url.path.endswith("/renamed.json"):
            return httpx.Response(301, headers={"Location": "/erddap/tabledap/A01_ocean_001m.json"})
        for name, target in elsewhere.items():
            if request.url.path.endswith(f"/{name}.json"):
                return httpx.Response(302, headers={"Location": target})
        return httpx.Response(404, content=(DATA / NO_MATCH).read_bytes())

    def check(erddap: Erddap) -> None:
        assert erddap.rows("renamed", ["time"]) == []  # followed: nothing matches there
        # Not to another host, nor from https to http, nor to another port.
        for name in elsewhere:
            with pytest.raises(ValueError, match="redirects to another origin"):
                erddap.rows(name, ["time"])

    with_the_sync_jobs_client(monkeypatch, session_factory, neracoos, check)

    tabledap = "https://data.neracoos.org/erddap/tabledap"
    assert requested == [
        f"{tabledap}/renamed.json",
        f"{tabledap}/A01_ocean_001m.json",
        *(f"{tabledap}/{name}.json" for name in elsewhere),
    ]


def test_a_request_has_a_deadline_however_many_redirects_it_follows(monkeypatch, session_factory):
    monkeypatch.setattr(Erddap, "DEADLINE", 0.2)
    requested: list[str] = []

    def round_and_round(request: httpx.Request) -> httpx.Response:
        # Each redirect well within the client's timeout, but they don't stop.
        requested.append(request.url.path)
        time.sleep(0.05)
        return httpx.Response(302, headers={"Location": request.url.path})

    def check(erddap: Erddap) -> None:
        with pytest.raises(TimeoutError, match="took longer than"):
            erddap.rows("A01_ocean_001m", ["time_modified"])

    with_the_sync_jobs_client(monkeypatch, session_factory, round_and_round, check)

    assert len(requested) < 10  # of the 20 redirects httpx would follow
