import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Buoy, HeatwaveEvent } from "../api/types";
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

// One heatwave runs from 2012 into 2013; none touches 2014.
const events = [heatwave("2012-12-25", "2013-01-03"), heatwave("2015-08-01", "2015-08-10")];

function renderAt(path: string, heatwaves: HeatwaveEvent[] = events) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData(keys.events, heatwaves);
  client.setQueryData(keys.buoys, [] as Buoy[]);
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <EventsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const yearSelect = () => screen.getByText("Year").closest("label")!.querySelector("select")!;
const offered = () => within(yearSelect()).getAllByRole("option").map((o) => o.textContent);

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

  it("offers the year filtered to when no heatwave touches it, as a heatmap cell can choose", () => {
    renderAt("/events?year=2014");

    expect(offered()).toEqual(["All", "2015", "2014", "2013", "2012"]);
    expect(yearSelect().value).toBe("2014");
  });
});
