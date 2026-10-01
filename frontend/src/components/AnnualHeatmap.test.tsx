import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
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
client.setQueryData([...keys.annual, 1], years);

function heatmap(selected: HeatmapSelection) {
  return (
    <QueryClientProvider client={client}>
      <AnnualHeatmap
        buoys={buoys}
        events={[]}
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
  it("starts at the recent years, and stays where the reader scrolled when a cell is selected", () => {
    const { container, rerender } = render(heatmap({ buoy: null, year: null }));
    const frame = container.querySelector<HTMLElement>(".chart")!;
    expect(frame.querySelector("svg")).toBeTruthy();
    expect(frame.scrollLeft).toBe(640);

    frame.scrollLeft = 120; // back to 2005
    rerender(heatmap({ buoy: "B01", year: 2005 }));

    expect(frame.scrollLeft).toBe(120);
  });
});
