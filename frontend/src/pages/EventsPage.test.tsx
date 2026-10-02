import * as Plot from "@observablehq/plot";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { withReading } from "../api/live";
import { keys } from "../api/queries";
import type { Buoy, Condition, HeatwaveEvent, ReadingMessage, YearSummary } from "../api/types";
import * as production from "../fixtures/production";
import { EventsPage } from "./EventsPage";

function heatwave(start_date: string, end_date: string): HeatwaveEvent {
  return {
    buoy_id: "B01",
    depth: 20,
    start_date,
    end_date,
    peak_date: start_date,
    duration: 10,
    max_intensity: 2.1,
    mean_intensity: 1.4,
    category: 1,
    category_name: "Moderate",
    origin: null,
    status: "ended",
  };
}

// Counts the charts drawn.
vi.mock("@observablehq/plot", async (importOriginal) => {
  const actual = await importOriginal<typeof Plot>();
  return { ...actual, plot: vi.fn(actual.plot) };
});

// One heatwave runs from 2012 into 2013; none touches 2014.
const events = [heatwave("2012-12-25", "2013-01-03"), heatwave("2015-08-01", "2015-08-10")];

function renderAt(path: string, heatwaves: HeatwaveEvent[] = events, buoys: Buoy[] = []) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(keys.events, heatwaves);
  client.setQueryData(keys.buoys, buoys);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <EventsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return client;
}

const select = (label: string) =>
  [...document.querySelectorAll(".filter-label")]
    .find((l) => l.textContent === label)!
    .closest("label")!
    .querySelector("select")!;
const yearSelect = () => select("Year");
const offered = (label = "Year") => within(select(label)).getAllByRole("option").map((o) => o.textContent);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]")));
  // jsdom has no layout: the heatmap never gets a width.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("EventsPage", () => {
  it("offers every year a heatwave ran into, as the year filter matches them", () => {
    renderAt("/events?year=2013");

    expect(offered()).toEqual(["All", "2015", "2013", "2012"]);
    expect(yearSelect().value).toBe("2013");
    expect(screen.getByText("1 heatwave, 10 days in all.")).toBeTruthy();
  });

  it("says a heatwave that hasn't ended is ongoing or paused, not that it ended", () => {
    renderAt("/events", [
      { ...heatwave("2026-09-21", "2026-10-01"), status: "ongoing" },
      { ...heatwave("2026-09-01", "2026-09-10"), buoy_id: "A01", status: "paused" },
      ...events,
    ]);

    const ends = screen.getAllByRole("row").slice(1).map((row) => row.querySelectorAll("td")[3].textContent);
    expect(ends).toEqual(["Ongoing", "Paused after Sep 10, 2026", "Aug 10, 2015", "Jan 3, 2013"]);
  });

  it("counts the heatwaves since the first buoy record, on production's data as it read when written out", () => {
    const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    client.setQueryData(keys.events, production.events);
    client.setQueryData(keys.buoys, production.buoys);
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/events"]}>
          <EventsPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(screen.getByText("All 858 marine heatwaves detected at the 7 buoys since 2001.")).toBeTruthy();
  });

  it("takes the first year from the buoys' records, not the satellite's", () => {
    const series = (first_date: string) => ({ depth: 1, first_date }) as Condition;
    renderAt("/events", events, [
      { id: "B01", series: [series("2004-06-04"), series("2005-01-01")], satellite: series("1981-09-01") },
    ] as Buoy[]);

    expect(screen.getByText("All 2 marine heatwaves detected at the 1 buoys since 2004.")).toBeTruthy();
  });

  it("offers the year filtered to when no heatwave touches it, as a heatmap cell can choose", () => {
    renderAt("/events?year=2014");

    expect(offered()).toEqual(["All", "2015", "2014", "2013", "2012"]);
    expect(yearSelect().value).toBe("2014");
  });

  it("redraws no heatmap when a reading comes in, or the yearly counts are refetched unchanged", async () => {
    // The heatmap is 600 px wide, so it's drawn.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe() {
          this.callback([{ contentRect: { width: 600 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        disconnect() {}
      },
    );
    const annual: YearSummary[] = [
      { buoy_id: "B01", depth: null, year: 2012, heatwave_days: 7, observed_days: 366 },
      { buoy_id: "B01", depth: null, year: 2013, heatwave_days: 3, observed_days: 365 },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(annual))));
    const b01 = { id: "B01", name: "Western Maine Shelf", series: [{ depth: 20, reading_at: null } as Condition] };
    const client = renderAt("/events", events, [b01 as Buoy]);
    await waitFor(() => expect(document.querySelector(".chart svg")).not.toBeNull());
    const drawn = vi.mocked(Plot.plot).mock.calls.length;

    // As the live feed writes in a reading, then refetches the yearly counts at any depth, which come back the same.
    // TanStack Query tells the heatmap on its next tick.
    const reading: ReadingMessage = { type: "reading", buoy: "B01", depth: 20, time: "2021-06-11T01:00:00Z", temperature: 9.5 };
    act(() => client.setQueryData<Buoy[]>(keys.buoys, (buoys) => buoys && withReading(buoys, reading)));
    await act(() => client.invalidateQueries({ queryKey: [...keys.annual, null] }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(vi.mocked(Plot.plot).mock.calls.length).toBe(drawn);

    // A new buoy is a new row.
    const a01 = { ...b01, id: "A01", name: "Massachusetts Bay" } as Buoy;
    act(() => client.setQueryData<Buoy[]>(keys.buoys, (buoys) => [a01, ...buoys!]));
    await waitFor(() => expect(vi.mocked(Plot.plot).mock.calls.length).toBe(drawn + 1));
  });

  it("asks for a click on the heatmap only when it has cells to click", async () => {
    // At 7 m, where no buoy has data, the yearly counts come back empty, as the stubbed fetch has them.
    renderAt("/events?depth=7");
    expect(await screen.findByText("No buoy has data at 7 m.")).toBeTruthy();
    expect(screen.queryByText(/Click a cell/)).toBeNull();
    cleanup();

    const annual: YearSummary[] = [{ buoy_id: "B01", depth: null, year: 2012, heatwave_days: 7, observed_days: 366 }];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(annual))));
    renderAt("/events");
    expect(
      await screen.findByText("A day with heatwaves at several depths counts once. Click a cell to list its heatwaves."),
    ).toBeTruthy();
  });

  it("offers a depth or buoy filtered to that no heatwave has, rather than reading All over an empty list", () => {
    renderAt("/events?depth=7&buoy=zzz");

    expect(offered("Depth")).toEqual(["All", "7 m", "20 m"]);
    expect(select("Depth").selectedOptions[0].textContent).toBe("7 m");
    expect(offered("Buoy")).toEqual(["All", "ZZZ"]);
    expect(select("Buoy").selectedOptions[0].textContent).toBe("ZZZ");
    expect(screen.getByText("0 heatwaves, 0 days in all.")).toBeTruthy();
  });
});
