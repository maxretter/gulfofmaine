import { partialMatchKey, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState } from "react";

import { keys } from "./queries";
import type { Buoy, LiveMessage, ReadingMessage, StatusMessage } from "./types";

export type LiveStatus = "connecting" | "live" | "reconnecting";

export interface Live {
  status: LiveStatus;
  /** When each buoy's newest reading arrived on the feed (Date.now()), for a marker to pulse. */
  pulses: Record<string, number>;
}

export const LiveContext = createContext<Live>({ status: "connecting", pulses: {} });

export function useLive(): Live {
  return useContext(LiveContext);
}

/** The server pings every 30 seconds; a connection silent for longer than this is taken as dead. */
export const SILENCE_MS = 75_000;
/**
 * How long the feed gathers what its messages make stale before refetching it. A sync round sends its messages, about
 * 15, within a second or two, so the refetches they prompt go out together, each query's once.
 */
export const GATHER_MS = 3_000;
const MAX_BACKOFF_MS = 60_000;

/** Wait before reconnect attempt `failures` + 1: doubling from 1 s to a minute, jittered so clients spread out. */
export function backoff(failures: number): number {
  return Math.min(1000 * 2 ** failures, MAX_BACKOFF_MS) * (0.5 + Math.random() / 2);
}

function feedUrl(): string {
  return `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/live`;
}

/** A reading written into one buoy's latest conditions; the list is unchanged if the reading isn't newer. */
export function withReading(buoys: Buoy[], reading: ReadingMessage): Buoy[] {
  return buoys.map((buoy) =>
    buoy.id !== reading.buoy
      ? buoy
      : {
          ...buoy,
          series: buoy.series.map((s) =>
            s.depth === reading.depth && (s.reading_at === null || s.reading_at < reading.time)
              ? { ...s, reading: reading.temperature, reading_at: reading.time }
              : s,
          ),
        },
  );
}

/**
 * A buoy depth (not the satellite) that has just gone into a heatwave: one reporting normally the day before, not
 * one coming back from an outage, or filled in for the first time, already in one, nor one whose paused heatwave
 * resumes: that is the same heatwave.
 */
export function enteredHeatwave(message: LiveMessage): message is StatusMessage {
  return (
    message.type === "status" &&
    message.depth > 0 &&
    message.state === "heatwave" &&
    (message.previous_state === "normal" || message.previous_state === "above_threshold")
  );
}

/**
 * One buoy depth entering a heatwave on one day: the status's newest day, as the message doesn't carry the heatwave's
 * start. A heatwave across a short dip is paused, not left, so it isn't entered again.
 */
export function alertId(alert: StatusMessage): string {
  return `${alert.buoy}-${alert.depth}-${alert.date}`;
}

/**
 * Brings the cache up to date with one message, and returns the queries it makes stale. A reading is written straight
 * into the latest conditions, so it shows at once; they are stale too, for what a reading can change but doesn't carry
 * (the day's mean, its anomaly), with the daily series at that buoy and depth and the stripes at that depth, which
 * average those means by month. A status message can mean a heatwave started, ended, grew a day or changed, so
 * everything built from heatwaves is stale as well.
 */
export function applyMessage(queryClient: QueryClient, message: LiveMessage): QueryKey[] {
  if (message.type === "ping") return [];
  if (message.type === "reading") {
    queryClient.setQueryData<Buoy[]>(keys.buoys, (buoys) => buoys && withReading(buoys, message));
  }
  const stale: QueryKey[] = [
    keys.buoys,
    [...keys.daily, message.buoy, message.depth],
    [...keys.stripes, message.depth],
  ];
  if (message.type === "status") stale.push(keys.events, keys.event, keys.annual, keys.agreement, keys.onsets);
  return stale;
}

/**
 * Marks every query under any of `stale` as stale, each once however many it's under. Only those on screen refetch
 * now; the rest when next shown.
 */
function invalidate(queryClient: QueryClient, stale: QueryKey[]) {
  void queryClient.invalidateQueries({
    predicate: (query) => stale.some((key) => partialMatchKey(query.queryKey, key)),
  });
}

/**
 * Keeps a WebSocket open to the live feed and writes its messages into the TanStack Query cache, refetching what they
 * make stale GATHER_MS after the first of them. Reconnects with backoff when the connection drops or goes silent, and
 * refetches everything on screen each time it connects, the first time too, to cover whatever was missed before the
 * feed was listening.
 */
export function useLiveFeed(onMessage?: (message: LiveMessage) => void): Live {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [pulses, setPulses] = useState<Record<string, number>>({});
  const callback = useRef(onMessage);
  useEffect(() => {
    callback.current = onMessage;
  });

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    let stale: QueryKey[] = []; // what messages have made stale since the last refetch
    let refetch: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const current = new WebSocket(feedUrl());
      socket = current;
      current.onopen = () => {
        // Anything could have changed since the page loaded what it shows, or while there was no connection. A first
        // load still on its way is left to finish rather than asked for again. Whatever was waiting to refetch is
        // part of everything.
        clearTimeout(refetch);
        refetch = undefined;
        stale = [];
        void queryClient.invalidateQueries();
        failures = 0;
        setStatus("live");
        watch();
      };
      current.onmessage = (event: MessageEvent<string>) => {
        watch();
        const message = JSON.parse(event.data) as LiveMessage;
        stale.push(...applyMessage(queryClient, message));
        if (stale.length > 0) refetch ??= setTimeout(refetchStale, GATHER_MS);
        if (message.type === "reading") setPulses((before) => ({ ...before, [message.buoy]: Date.now() }));
        callback.current?.(message);
      };
      current.onclose = reconnect;
    };

    /** Drops the current connection, if any, and tries again after a backoff. */
    const reconnect = () => {
      clearTimeout(watchdog);
      if (socket) {
        socket.onclose = null;
        socket.close();
        socket = null;
      }
      setStatus("reconnecting");
      retry = setTimeout(connect, backoff(failures));
      failures += 1;
    };

    const watch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(reconnect, SILENCE_MS);
    };

    const refetchStale = () => {
      invalidate(queryClient, stale);
      stale = [];
      refetch = undefined;
    };

    connect();
    return () => {
      clearTimeout(retry);
      clearTimeout(watchdog);
      clearTimeout(refetch);
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
    };
  }, [queryClient]);

  return { status, pulses };
}
