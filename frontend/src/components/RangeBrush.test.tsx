import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RangeBrush } from "./RangeBrush";

/** The record strip at B01 1 m, its days answered with `status`. */
function renderStrip(status: number) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ detail: "Not found" }), { status })));
  // A failure that's retried fails at once.
  const client = new QueryClient({ defaultOptions: { queries: { retryDelay: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <RangeBrush
        buoy="B01"
        depth={1}
        firstDate="2024-06-01"
        lastDate="2026-09-30"
        from="2025-10-01"
        to="2026-09-30"
        events={[]}
        onChange={() => {}}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
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

describe("RangeBrush", () => {
  it("says there's no record at a depth the API has none for, rather than that it failed", async () => {
    renderStrip(404);

    expect(await screen.findByText("No record at 1 m.")).toBeTruthy();
    expect(screen.queryByText("Couldn't load the full record.")).toBeNull();
  });

  it("says it couldn't load the record when the API fails", async () => {
    renderStrip(500);

    expect(await screen.findByText("Couldn't load the full record.")).toBeTruthy();
  });
});
