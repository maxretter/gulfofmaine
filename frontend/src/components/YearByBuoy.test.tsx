import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { range } from "d3";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Buoy, BuoyYear, Condition, HeatwaveEvent, Onsets, Origin } from "../api/types";
import { addDays, daysBetween } from "../lib/dates";
import { YearByBuoy } from "./YearByBuoy";

const dates = range(365).map((i) => addDays("2021-01-01", i));

function heatwave(buoy_id: string, start_date: string, end_date: string, origin: Origin): HeatwaveEvent {
  return {
    buoy_id,
    depth: 50,
    start_date,
    end_date,
    peak_date: start_date,
    duration: daysBetween(start_date, end_date) + 1,
    max_intensity: 2.5,
    mean_intensity: 1.8,
    category: 1,
    category_name: "Moderate",
    origin,
    status: "ended",
  };
}

/** A buoy's year as the API sends it: each day names the heatwave it was part of by its start date. */
function buoyYear(buoy_id: string, heatwaves: HeatwaveEvent[]): BuoyYear {
  return {
    buoy_id,
    heatwaves,
    anomaly: dates.map(() => 0.5),
    heatwave: dates.map((day) => heatwaves.find((h) => h.start_date <= day && day <= h.end_date)?.start_date ?? null),
  };
}

const buoy = (id: string, name: string, longitude: number) =>
  ({ id, name, latitude: 43, longitude, series: [{ depth: 50 } as Condition], satellite: null }) satisfies Buoy;
const buoys = [buoy("A01", "Massachusetts Bay", -70.5), buoy("M01", "Jordan Basin", -67.9)];

// M01 is east of A01; A01's year opens in a heatwave carried over from December.
const onsets: Onsets = {
  year: 2021,
  depth: 50,
  dates,
  buoys: [
    buoyYear("A01", [
      heatwave("A01", "2020-12-20", "2021-01-05", "surface"),
      heatwave("A01", "2021-04-14", "2021-04-28", "offshore"),
    ]),
    buoyYear("M01", [heatwave("M01", "2021-02-13", "2021-02-22", "offshore")]),
  ],
};

function Opened() {
  return <p>Opened {useLocation().pathname}</p>;
}

function renderYear(year: Onsets = onsets) {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
  client.setQueryData([...keys.onsets, 2021, 50], year);
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/origins"]}>
        <Routes>
          <Route path="/origins" element={<YearByBuoy year={2021} depth={50} buoys={buoys} />} />
          <Route path="/events/*" element={<Opened />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ contentRect: { width: 717 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
    },
  );
  // jsdom has no canvas, which Plot paints the anomaly legend's ramp on.
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ fillRect() {} } as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("");
  // Nor does it lay out text, which Plot measures to fit a tip.
  Object.defineProperty(SVGElement.prototype, "getBBox", {
    configurable: true,
    value: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (SVGElement.prototype as { getBBox?: unknown }).getBBox;
});

/** The chart's table: its column labels, then each row's cells. */
function openTable(container: HTMLElement): string[][] {
  const table = container.querySelector("details")!;
  table.open = true;
  fireEvent(table, new Event("toggle"));
  return [
    [...container.querySelectorAll("thead th")].map((cell) => cell.textContent!),
    ...[...container.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent!),
    ),
  ];
}

describe("YearByBuoy", () => {
  it("draws and lists the API's heatwaves for the year, east to west, one carried over from December too", () => {
    const { container } = renderYear();

    const [, bars] = container.querySelectorAll('g[aria-label="rect"]');
    expect(bars.querySelectorAll("rect")).toHaveLength(3);
    const [columns, ...rows] = openTable(container);
    expect(columns).toEqual(["Buoy", "Start", "End", "Days", "Origin"]);
    expect(rows).toEqual([
      ["M01", "Feb 13, 2021", "Feb 22, 2021", "10", "Offshore"],
      ["A01", "Dec 20, 2020", "Jan 5, 2021", "17", "Surface"],
      ["A01", "Apr 14, 2021", "Apr 28, 2021", "15", "Offshore"],
    ]);
  });

  it("lists a heatwave that hasn't ended as ongoing or paused, not with an end", () => {
    const [a01, m01] = onsets.buoys;
    const [december, april] = a01.heatwaves;
    const { container } = renderYear({
      ...onsets,
      buoys: [
        { ...a01, heatwaves: [december, { ...april, status: "ongoing" }] },
        { ...m01, heatwaves: [{ ...m01.heatwaves[0], status: "paused" }] },
      ],
    });

    const [, ...rows] = openTable(container);
    expect(rows.map((row) => row[2])).toEqual(["Paused after Feb 22, 2021", "Jan 5, 2021", "Ongoing"]);
  });

  it("opens the heatwave a day was part of, though it began the year before", async () => {
    const { container, findByText } = renderYear();
    const svg = container.querySelector("svg")!;
    // Jan 3 on A01's row: 170 px of labels, then 535 px for the year; rows 44 px tall, M01's on top.
    fireEvent.pointerMove(svg, { clientX: 170 + (2.5 / 365) * 535, clientY: 44 + 22, pointerType: "mouse" });
    fireEvent.click(svg);

    expect(await findByText("Opened /events/A01/50/2020-12-20")).toBeTruthy();
  });
});
