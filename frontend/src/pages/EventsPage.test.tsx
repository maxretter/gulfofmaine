import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Buoy, Condition, HeatwaveEvent } from "../api/types";
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

  it("offers a depth or buoy filtered to that no heatwave has, rather than reading All over an empty list", () => {
    renderAt("/events?depth=7&buoy=zzz");

    expect(offered("Depth")).toEqual(["All", "7 m", "20 m"]);
    expect(select("Depth").selectedOptions[0].textContent).toBe("7 m");
    expect(offered("Buoy")).toEqual(["All", "ZZZ"]);
    expect(select("Buoy").selectedOptions[0].textContent).toBe("ZZZ");
    expect(screen.getByText("0 heatwaves, 0 days in all.")).toBeTruthy();
  });
});
