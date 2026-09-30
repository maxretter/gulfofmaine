import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { DataProduct } from "../api/types";
import { ProductTable } from "./DataTables";

afterEach(cleanup);

function product(buoy: string | null, depth: number | null, sizes: [number, number]): DataProduct {
  const path = buoy ? `/api/data/${buoy}/${depth}` : "/api/data/events";
  return {
    name: buoy ? `${buoy}_heatwaves_${String(depth).padStart(3, "0")}m` : "gom_heatwaves_events",
    buoy_id: buoy,
    depth,
    files: [
      { format: "nc", url: `${path}.nc`, size: sizes[0], modified: "2026-09-29T13:00:00Z" },
      { format: "csv", url: `${path}.csv`, size: sizes[1], modified: "2026-09-29T13:00:00Z" },
    ],
  };
}

describe("ProductTable", () => {
  it("groups each buoy's depths under it, with a sized link per format", () => {
    const products = [
      product("A01", 1, [941_336, 2_046_307]),
      product("A01", 50, [941_336, 2_074_354]),
      product("M01", 250, [830_000, 1_800_000]),
      product(null, null, [99_642, 81_656]),
    ];
    render(<ProductTable products={products} names={new Map([["A01", "Massachusetts Bay"]])} />);

    const a01 = screen.getByRole("rowheader", { name: /A01/ });
    expect(a01.getAttribute("rowspan")).toBe("2");
    expect(within(a01).getByText("Massachusetts Bay")).toBeTruthy();
    const link = screen.getByRole("link", { name: "A01 50 m, CSV, 2.1 MB" });
    expect(link.getAttribute("href")).toBe("/api/data/A01/50.csv");
    expect(screen.getByRole("link", { name: "Events table, NetCDF, 100 KB" }).getAttribute("href")).toBe(
      "/api/data/events.nc",
    );
  });
});
