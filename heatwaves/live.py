"""The live feed: new readings and heatwave changes, pushed to browsers over a WebSocket.

    sync (any process) --NOTIFY--> Postgres --LISTEN--> API --WebSocket--> browsers

The sync job (heatwaves.sync), a separate process, publishes what changed
with Postgres NOTIFY, in the transaction that stores it, so a message goes
out only once its data is committed. Each API process holds one LISTEN
connection and relays every message to the browsers connected to it. No
broker or queue is needed beyond the database. On SQLite there is no
NOTIFY, and the feed only pings.
"""

import asyncio
import datetime as dt
import ipaddress
import logging
from collections import Counter
from collections.abc import Collection, Iterable, Sequence
from typing import Literal
from urllib.parse import urlsplit

import anyio
import psycopg
from fastapi import WebSocket, WebSocketDisconnect, status
from pydantic import BaseModel
from sqlalchemy import func, make_url, select
from sqlalchemy.orm import Session

from heatwaves.config import settings
from heatwaves.models import Series
from heatwaves.state import SeriesState, State

log = logging.getLogger(__name__)

CHANNEL = "live"
PING_EVERY = 30.0  # seconds; keeps idle connections open through proxies and tunnels
# Heatwaves an OriginsMessage lists at most. Postgres takes a NOTIFY payload of under 8000 bytes,
# and each heatwave is about 70 (tests/test_live.py checks the longest).
ORIGINS_PER_MESSAGE = 100


class ReadingMessage(BaseModel):
    """A buoy depth has a newer temperature reading, one that passed quality control."""

    type: Literal["reading"] = "reading"
    buoy: str
    depth: int
    time: dt.datetime
    temperature: float  # degrees C


class StatusMessage(BaseModel):
    """A series' state changed, or its heatwave in progress or paused did (its dates, category or intensity).

    A heatwave that only grew or changed has "heatwave" as both states; a paused one that changed, "paused".
    A heatwave that dips below the threshold is "paused" while what follows could still be joined to it
    (heatwaves.state), and "heatwave" again, the same one, if it is. Depth 0 is the satellite.
    """

    type: Literal["status"] = "status"
    buoy: str
    depth: int
    date: dt.date | None  # newest day with data
    state: State
    category: int | None  # of the heatwave in progress or paused
    days_above: int  # consecutive days above the threshold, ending on `date`
    previous_state: State
    previous_category: int | None


class JudgedHeatwave(BaseModel):
    """A heatwave, by its buoy, depth and first day, as the API addresses it, and its last day."""

    buoy: str
    depth: int
    start: dt.date
    end: dt.date


class OriginsMessage(BaseModel):
    """Heatwaves whose origin, or the evidence for it, came out different when judged again.

    A heatwave at the depths heatwaves.origin labels is judged again when days
    its evidence comes from change, at its own buoy or another, and judged
    for the first time when it's found. A store lists every one whose label or
    evidence changed, ORIGINS_PER_MESSAGE to a message.
    """

    type: Literal["origins"] = "origins"
    heatwaves: list[JudgedHeatwave]


class PingMessage(BaseModel):
    type: Literal["ping"] = "ping"
    time: dt.datetime


Message = ReadingMessage | StatusMessage | OriginsMessage | PingMessage


def reading_message(series: Series) -> ReadingMessage:
    assert series.latest_reading_at is not None and series.latest_reading is not None
    return ReadingMessage(
        buoy=series.buoy_id,
        depth=series.depth,
        time=series.latest_reading_at,
        temperature=series.latest_reading,
    )


def status_message(series: Series, before: SeriesState, after: SeriesState) -> StatusMessage:
    return StatusMessage(
        buoy=series.buoy_id,
        depth=series.depth,
        date=series.latest_date,
        state=after.state,
        category=after.category,
        days_above=series.days_above,
        previous_state=before.state,
        previous_category=before.category,
    )


def origins_messages(heatwaves: Sequence[JudgedHeatwave]) -> list[OriginsMessage]:
    """The heatwaves judged again with a different outcome, in as few messages as NOTIFY carries."""
    return [
        OriginsMessage(heatwaves=list(heatwaves[start : start + ORIGINS_PER_MESSAGE]))
        for start in range(0, len(heatwaves), ORIGINS_PER_MESSAGE)
    ]


def publish(session: Session, messages: Iterable[Message]) -> None:
    """Send messages to every browser on the feed once the session's transaction commits."""
    if session.get_bind().dialect.name != "postgresql":
        return
    for message in messages:
        session.execute(select(func.pg_notify(CHANNEL, message.model_dump_json())))


def libpq_url(database_url: str) -> str | None:
    """The database URL as psycopg takes it, or None if the database isn't Postgres."""
    url = make_url(database_url)
    if url.get_backend_name() != "postgresql":
        return None
    return url.set(drivername="postgresql").render_as_string(hide_password=False)


def address_key(host: str) -> str:
    """What a connection from `host` counts against: its IPv4 address, or its IPv6 /64.

    A household or a phone is usually given a whole /64, so one client could
    otherwise open each connection from an address of its own.
    """
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return host
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return str(address.ipv4_mapped)
        return str(ipaddress.IPv6Network((address, 64), strict=False))
    return str(address)


class Hub:
    """The browsers connected to this process, each with a queue of messages to send it."""

    BACKLOG = 100  # messages a browser can fall behind by before it's disconnected

    def __init__(self, max_clients: int, max_per_address: int) -> None:
        self.max_clients = max_clients
        self.max_per_address = max_per_address
        # Each browser's queue, and the address it counts against (address_key).
        # None in a queue tells its connection to close.
        self.clients: dict[asyncio.Queue[str | None], str] = {}
        self.per_address: Counter[str] = Counter()

    def join(self, host: str) -> asyncio.Queue[str | None] | None:
        """A queue for a new browser at `host`, or None if the feed is full or has max_per_address from there.

        Without the second limit, one client could take every place. Behind
        proxies, `host` is the visitor's only if each passes it on (TRUSTED_PROXIES
        in frontend/Caddyfile, FORWARDED_ALLOW_IPS for uvicorn); otherwise every
        visitor shares the proxy's, and its limit.
        """
        address = address_key(host)
        if len(self.clients) >= self.max_clients:
            return None
        if self.per_address[address] >= self.max_per_address:
            log.warning(
                "Refused a live feed connection from %s, which has %d; LIVE_MAX_PER_ADDRESS can raise it",
                address,
                self.max_per_address,
            )
            return None
        queue: asyncio.Queue[str | None] = asyncio.Queue(self.BACKLOG)
        self.clients[queue] = address
        self.per_address[address] += 1
        return queue

    def leave(self, queue: asyncio.Queue[str | None]) -> None:
        address = self.clients.pop(queue, None)
        if address is not None:
            self.per_address[address] -= 1
            if not self.per_address[address]:
                del self.per_address[address]

    def publish(self, message: str) -> None:
        for queue in list(self.clients):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                self.disconnect(queue)

    def disconnect_all(self) -> None:
        for queue in list(self.clients):
            self.disconnect(queue)

    @staticmethod
    def disconnect(queue: asyncio.Queue[str | None]) -> None:
        """Close a browser's connection, so it reconnects and refetches what it missed."""
        while not queue.empty():
            queue.get_nowait()
        queue.put_nowait(None)


hub = Hub(settings.live_max_clients, settings.live_max_per_address)


async def relay(url: str, hub: Hub, retry: float = 5.0) -> None:
    """Pass every message on CHANNEL to the hub's browsers, until canceled.

    Messages sent while the connection is down are lost, so once it's back
    every browser is disconnected, to reconnect and refetch.
    """
    lost = False
    while True:
        try:
            async with await psycopg.AsyncConnection.connect(
                url, autocommit=True, keepalives=1, keepalives_idle=60
            ) as connection:
                await connection.execute(f"LISTEN {CHANNEL}")
                log.info("Listening for live updates")
                if lost:
                    hub.disconnect_all()
                async for notice in connection.notifies():
                    hub.publish(notice.payload)
        except psycopg.Error as error:
            log.warning("Live feed's database connection failed (%s); retrying in %.0f s", error, retry)
        lost = True
        await asyncio.sleep(retry)


def allowed_origin(websocket: WebSocket, others: Collection[str], hosts: Collection[str] = ()) -> bool:
    """Whether the connection is from a page on the site itself or on one of `others`, or not from a browser.

    A browser opens a WebSocket from any site's page, to any server, and
    sends that page's origin with it. This keeps other sites from holding
    the feed's connections open with their visitors' browsers. Clients that
    aren't browsers send no Origin, or any they like, so it doesn't limit them.
    Behind a proxy, the Host header has to be the one the browser sent, as
    Caddy and Vite's dev server pass it on.

    With DNS rebinding, another site's name can point at this server, and a
    page at it then has an Origin matching its Host. If `hosts` are given, the
    site's own pages are those at one of them alone.
    """
    origin = websocket.headers.get("origin")
    if origin is None or origin.lower() in others:
        return True
    host = websocket.headers.get("host", "").lower()
    if hosts and host not in hosts:
        return False
    return urlsplit(origin).netloc.lower() == host


async def serve(websocket: WebSocket, hub: Hub) -> None:
    """Send one browser every message from the hub, and a ping whenever it's been quiet for PING_EVERY."""
    if not allowed_origin(websocket, settings.live_origins, settings.live_hosts):
        log.warning(
            "Refused a live feed connection from a page at %s (Host %s); see LIVE_ORIGINS and LIVE_HOSTS",
            websocket.headers.get("origin"),
            websocket.headers.get("host"),
        )
        # Refused before the handshake, which the browser sees as a 403.
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    queue = hub.join(websocket.client.host if websocket.client else "")
    if queue is None:
        # Refused before the handshake; the browser retries later.
        await websocket.close(code=status.WS_1013_TRY_AGAIN_LATER)
        return
    try:
        await websocket.accept()
        async with anyio.create_task_group() as tasks:

            async def until_closed() -> None:
                await _receive_until_closed(websocket)
                tasks.cancel_scope.cancel()

            tasks.start_soon(until_closed)
            await _send(websocket, queue)
            tasks.cancel_scope.cancel()
    except* WebSocketDisconnect:
        pass
    finally:
        hub.leave(queue)


async def _send(websocket: WebSocket, queue: asyncio.Queue[str | None]) -> None:
    while True:
        message: str | None = None
        with anyio.move_on_after(PING_EVERY) as quiet:
            message = await queue.get()
        if quiet.cancelled_caught:
            message = PingMessage(time=dt.datetime.now(dt.UTC)).model_dump_json()
        elif message is None:
            await websocket.close(code=status.WS_1013_TRY_AGAIN_LATER)
            return
        await websocket.send_text(message)


async def _receive_until_closed(websocket: WebSocket) -> None:
    """Returns once the browser closes the connection. Anything it sends is ignored."""
    while (await websocket.receive())["type"] != "websocket.disconnect":
        pass
