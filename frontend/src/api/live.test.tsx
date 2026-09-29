import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { HeatwaveToasts } from "../components/HeatwaveToasts";
import { enteredHeatwave, SILENCE_MS, useLiveFeed, withReading } from "./live";
import { keys } from "./queries";
import type { Buoy, Condition, LiveMessage, ReadingMessage, StatusMessage } from "./types";

/** Stands in for the browser's WebSocket; the test plays the server. */
class MockSocket {
  static instances: MockSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    MockSocket.instances.push(this);
  }

  close() {
    this.closed = true;
  }

  open() {
    this.onopen?.();
  }

  deliver(message: LiveMessage) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  drop() {
    this.onclose?.();
  }
}

function latestSocket(): MockSocket {
  return MockSocket.instances[MockSocket.instances.length - 1];
}

function condition(depth: number): Condition {
  return {
    depth,
    dataset_id: `B01_ocean_${String(depth).padStart(3, "0")}m`,
    erddap_url: "",
    state: "normal",
    first_date: "2001-07-10",
    date: "2026-09-28",
    temperature: 11.2,
    climatology: 10.1,
    anomaly: 1.1,
    threshold: 11.8,
    days_above: 0,
    category: null,
    category_name: null,
    event_start: null,
    synced_at: "2026-09-29T01:20:00Z",
    reading_at: "2026-09-29T01:00:00Z",
    reading: 11.4,
  };
}

const buoys: Buoy[] = [
  {
    id: "B01",
    name: "Western Maine Shelf",
    latitude: 43.2,
    longitude: -70.4,
    series: [condition(1), condition(50)],
    satellite: null,
  },
];

const reading: ReadingMessage = { type: "reading", buoy: "B01", depth: 50, time: "2026-09-29T02:00:00Z", temperature: 11.9 };

const entered: StatusMessage = {
  type: "status",
  buoy: "B01",
  depth: 50,
  date: "2026-09-28",
  state: "heatwave",
  category: 1,
  days_above: 5,
  previous_state: "above_threshold",
  previous_category: null,
};

function setup(onMessage?: (message: LiveMessage) => void) {
  const queryClient = new QueryClient();
  queryClient.setQueryData(keys.buoys, buoys);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useLiveFeed(onMessage), { wrapper });
  return { queryClient, ...hook };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", MockSocket);
  vi.spyOn(Math, "random").mockReturnValue(1); // no jitter: backoffs of exactly 1 s, 2 s, 4 s…
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  MockSocket.instances = [];
});

describe("useLiveFeed", () => {
  it("writes each new reading into the latest conditions, and pulses that buoy", () => {
    const { queryClient, result } = setup();
    const socket = latestSocket();
    expect(socket.url).toBe(`ws://${location.host}/api/live`);
    expect(result.current.status).toBe("connecting");

    act(() => socket.open());
    act(() => socket.deliver(reading));

    expect(result.current.status).toBe("live");
    const [b01] = queryClient.getQueryData<Buoy[]>(keys.buoys)!;
    expect(b01.series.map((s) => s.reading)).toEqual([11.4, 11.9]);
    expect(b01.series[1].reading_at).toBe(reading.time);
    expect(result.current.pulses.B01).toBeTypeOf("number");
  });

  it("refetches everything built from heatwaves when a status changes, and passes the message on", () => {
    const onMessage = vi.fn();
    const { queryClient } = setup(onMessage);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    act(() => latestSocket().open());
    act(() => latestSocket().deliver(entered));

    const refetched = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(refetched).toEqual(
      expect.arrayContaining([keys.buoys, ["daily", "B01"], keys.events, keys.annual, keys.onsets]),
    );
    expect(onMessage).toHaveBeenCalledWith(entered);
  });

  it("reconnects with a growing backoff, then refetches what it may have missed", () => {
    const { queryClient, result } = setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    act(() => latestSocket().open());
    expect(invalidate).not.toHaveBeenCalled();

    act(() => latestSocket().drop());
    expect(result.current.status).toBe("reconnecting");
    act(() => vi.advanceTimersByTime(999));
    expect(MockSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(MockSocket.instances).toHaveLength(2);

    act(() => latestSocket().drop()); // refused this time
    act(() => vi.advanceTimersByTime(2000));
    expect(MockSocket.instances).toHaveLength(3);
    act(() => latestSocket().open());

    expect(result.current.status).toBe("live");
    expect(invalidate).toHaveBeenCalledWith();
  });

  it("replaces a connection that has gone quiet for longer than the server's pings allow", () => {
    setup();
    const first = latestSocket();
    act(() => first.open());

    act(() => vi.advanceTimersByTime(SILENCE_MS - 1));
    act(() => first.deliver({ type: "ping", time: "2026-09-29T02:00:30Z" }));
    act(() => vi.advanceTimersByTime(SILENCE_MS - 1));
    expect(first.closed).toBe(false);
    act(() => vi.advanceTimersByTime(1));

    expect(first.closed).toBe(true);
    act(() => vi.advanceTimersByTime(1000));
    expect(MockSocket.instances).toHaveLength(2);
  });

  it("closes its connection when the page no longer needs it", () => {
    const { unmount } = setup();
    act(() => latestSocket().open());

    unmount();
    act(() => vi.advanceTimersByTime(10 * SILENCE_MS));

    expect(latestSocket().closed).toBe(true);
    expect(MockSocket.instances).toHaveLength(1);
  });
});

describe("live messages", () => {
  it("keeps the newer reading when an older one arrives late", () => {
    const late = { ...reading, time: "2026-09-29T00:00:00Z", temperature: 10.0 };
    expect(withReading(buoys, late)[0].series[1].reading).toBe(11.4);
  });

  it("announces a buoy depth entering a heatwave, not a change within one or at the satellite", () => {
    expect(enteredHeatwave(entered)).toBe(true);
    expect(enteredHeatwave({ ...entered, previous_state: "heatwave", category: 2, previous_category: 1 })).toBe(false);
    expect(enteredHeatwave({ ...entered, depth: 0 })).toBe(false);
    expect(enteredHeatwave({ ...entered, previous_state: "offline" })).toBe(false);
    expect(enteredHeatwave({ ...entered, previous_state: "no_data" })).toBe(false);
    expect(enteredHeatwave(reading)).toBe(false);
  });

  it("shows a notice for each heatwave that starts, until dismissed or for 20 seconds", () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(keys.buoys, buoys);
    const onDismiss = vi.fn();
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <HeatwaveToasts alerts={[entered]} onDismiss={onDismiss} />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText(/Western Maine Shelf entered a moderate heatwave at 50 m/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "See it" }).getAttribute("href")).toBe("/buoys/B01?depth=50");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenCalledWith("B01-50-2026-09-28");
    act(() => vi.advanceTimersByTime(20_000));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
