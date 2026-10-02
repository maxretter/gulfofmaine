import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { range } from "d3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { keys } from "../api/queries";
import type { Buoy, YearSummary } from "../api/types";
import { AnnualHeatmap, type HeatmapSelection } from "./AnnualHeatmap";

const buoys = [{ id: "B01", name: "Western Maine Shelf", series: [] }] as unknown as Buoy[];
const years: YearSummary[] = range(2001, 2026).map((year) => ({
  buoy_id: "B01",
  depth: 1,
  year,
  heatwave_days: 0,
  observed_days: 365,
}));

const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
client.setQueryData([...keys.annual, 1, 1, null], years);

function heatmap(selected: HeatmapSelection) {
  return (
    <QueryClientProvider client={client}>
      <AnnualHeatmap
        buoys={buoys}
        depth={1}
        minCategory={1}
        origin={null}
        selected={selected}
        onSelect={() => {}}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  // A phone: the frame is 360 px wide, and the grid, at least 640 px, scrolls sideways within it.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {
        this.callback([{ contentRect: { width: 360 } } as ResizeObserverEntry], this as unknown as ResizeObserver);
      }
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(640);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AnnualHeatmap", () => {
  it("says so when no buoy has data at the depth, rather than drawing nothing", () => {
    client.setQueryData([...keys.annual, 7, 1, null], []);
    const { getByText } = render(
      <QueryClientProvider client={client}>
        <AnnualHeatmap
          buoys={buoys}
          depth={7}
          minCategory={1}
          origin={null}
          selected={{ buoy: null, year: null }}
          onSelect={() => {}}
        />
      </QueryClientProvider>,
    );

    expect(getByText("No buoy has data at 7 m.")).toBeTruthy();
  });

  it("starts at the recent years, and stays where the reader scrolled when a cell is selected", () => {
    const { container, rerender } = render(heatmap({ buoy: null, year: null }));
    const frame = container.querySelector<HTMLElement>(".chart")!;
    expect(frame.querySelector("svg")).toBeTruthy();
    expect(frame.scrollLeft).toBe(640);

    frame.scrollLeft = 120; // back to 2005
    rerender(heatmap({ buoy: "B01", year: 2005 }));

    expect(frame.scrollLeft).toBe(120);
  });

  it("shows the heatwave days the API counts for the filters, and none for a year too little observed", () => {
    client.setQueryData(
      [...keys.annual, null, 2, "offshore"],
      [
        { buoy_id: "B01", depth: null, year: 2012, heatwave_days: 40, observed_days: 366 },
        { buoy_id: "B01", depth: null, year: 2013, heatwave_days: 3, observed_days: 100 },
      ] satisfies YearSummary[],
    );
    const { container } = render(
      <QueryClientProvider client={client}>
        <AnnualHeatmap
          buoys={buoys}
          depth={null}
          minCategory={2}
          origin="offshore"
          selected={{ buoy: null, year: null }}
          onSelect={() => {}}
        />
      </QueryClientProvider>,
    );
    const table = container.querySelector("details")!;
    table.open = true;
    fireEvent(table, new Event("toggle"));

    const rows = [...container.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => cell.textContent),
    );
    expect(rows).toEqual([
      ["B01 Western Maine Shelf", "2012", "40", "366"],
      ["B01 Western Maine Shelf", "2013", "–", "100"],
    ]);
  });
});
