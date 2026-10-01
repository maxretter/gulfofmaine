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
import logging
from collections.abc import Collection, Iterable
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


class PingMessage(BaseModel):
    type: Literal["ping"] = "ping"
    time: dt.datetime


Message = ReadingMessage | StatusMessage | PingMessage


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


class Hub:
    """The browsers connected to this process, each with a queue of messages to send it."""

    BACKLOG = 100  # messages a browser can fall behind by before it's disconnected

    def __init__(self, max_clients: int) -> None:
        self.max_clients = max_clients
        # None in a queue tells its connection to close.
        self.clients: set[asyncio.Queue[str | None]] = set()

    def join(self) -> asyncio.Queue[str | None] | None:
        """A queue for a new browser, or None if the feed is full."""
        if len(self.clients) >= self.max_clients:
            return None
        queue: asyncio.Queue[str | None] = asyncio.Queue(self.BACKLOG)
        self.clients.add(queue)
        return queue

    def leave(self, queue: asyncio.Queue[str | None]) -> None:
        self.clients.discard(queue)

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


hub = Hub(settings.live_max_clients)


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


def allowed_origin(websocket: WebSocket, others: Collection[str]) -> bool:
    """Whether the connection is from a page on the site itself or on one of `others`, or not from a browser.

    A browser opens a WebSocket from any site's page, to any server, and
    sends that page's origin with it. This keeps other sites from holding
    the feed's connections open with their visitors' browsers. Clients that
    aren't browsers send no Origin, or any they like, so it doesn't limit them.
    Behind a proxy, the Host header has to be the one the browser sent, as
    Caddy and Vite's dev server pass it on.
    """
    origin = websocket.headers.get("origin")
    if origin is None or origin.lower() in others:
        return True
    return urlsplit(origin).netloc.lower() == websocket.headers.get("host", "").lower()


async def serve(websocket: WebSocket, hub: Hub) -> None:
    """Send one browser every message from the hub, and a ping whenever it's been quiet for PING_EVERY."""
    if not allowed_origin(websocket, settings.live_origins):
        log.warning(
            "Refused a live feed connection from a page at %s (Host %s); LIVE_ORIGINS can allow it",
            websocket.headers.get("origin"),
            websocket.headers.get("host"),
        )
        # Refused before the handshake, which the browser sees as a 403.
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        return
    queue = hub.join()
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
