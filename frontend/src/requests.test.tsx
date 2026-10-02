import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Method } from "./api/types";
import { routes } from "./router";

// What a first visit asks the API for, and when: each request and each answer in the order they happen, with the
// moment a page's code arrives. Answers wait until the test gives them, as over a slow connection, and so does the
// satellite page's code.
const timeline = vi.hoisted(() => [] as string[]);
const pageCode = vi.hoisted(() => {
  let arrive = () => {};
  const arrived = new Promise<void>((done) => (arrive = done));
  return { arrived, arrive: () => arrive() };
});
vi.mock("./pages/SatellitePage", async (original) => {
  await pageCode.arrived;
  timeline.push("satellite page's code");
  return original();
});

const method: Method = {
  baseline_start: 2003,
  baseline_end: 2022,
  percentile: 90,
  window_half_width: 5,
  smooth_width: 31,
  min_duration: 5,
  max_gap: 2,
  max_pad: 2,
  categories: ["Moderate", "Strong", "Severe", "Extreme"],
  min_hours: 18,
  offline_after: 3,
  depths: [1, 20, 50],
};

/** Requests not answered yet, by path. */
let waiting: { path: string; answer: () => void }[] = [];

/** Answers every request waiting whose path starts with `prefix`. */
async function answer(prefix: string) {
  await act(async () => {
    for (const each of waiting.filter((w) => w.path.startsWith(prefix))) each.answer();
    waiting = waiting.filter((w) => !w.path.startsWith(prefix));
  });
}

const requested = () => timeline.filter((e) => e.startsWith("→")).map((e) => e.slice(2));
const at = (entry: string) => timeline.findIndex((e) => e.startsWith(entry));

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  timeline.length = 0;
  waiting = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => {
      timeline.push(`→ ${path}`);
      const body = path === "/api/method" ? method : path === "/api/origin/rules" ? {} : [];
      return new Promise<Response>((resolve) =>
        waiting.push({
          path,
          answer: () => {
            timeline.push(`← ${path}`);
            resolve(new Response(JSON.stringify(body)));
          },
        }),
      );
    }),
  );
  vi.stubGlobal("scrollTo", () => {}); // jsdom has no scrolling
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  // The live feed never connects.
  vi.stubGlobal(
    "WebSocket",
    class {
      close() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("a first visit", () => {
  it("asks for the heatwaves and the yearly summary together, rather than the summary once the heatwaves arrive", async () => {
    renderAt("/events");

    await vi.waitFor(() => expect(requested()).toContain("/api/events"));
    await vi.waitFor(() => expect(requested()).toContain("/api/annual"));
    expect(timeline.filter((e) => e.startsWith("←"))).toEqual([]);

    await answer("/");
    expect(await screen.findByText("Every heatwave on record")).toBeTruthy();
    expect(requested().filter((path) => path.startsWith("/api/annual"))).toEqual(["/api/annual"]);
  });

  it("asks for the method while the satellite page's code is on its way, and its comparisons once both are in", async () => {
    renderAt("/satellite");

    // The header is up, the page's code not yet: the method, which says the depths to compare, is already asked for.
    await vi.waitFor(() => expect(requested()).toEqual(expect.arrayContaining(["/api/buoys", "/api/method"])));
    await answer("/api/method");
    await act(async () => pageCode.arrive());

    // The comparisons are asked for as soon as the page draws, without another round trip for the method.
    await vi.waitFor(() =>
      expect(requested()).toEqual(
        expect.arrayContaining(["/api/agreement?depth=1", "/api/agreement?depth=20", "/api/agreement?depth=50"]),
      ),
    );
    expect(at("→ /api/method")).toBeLessThan(at("satellite page's code"));
    expect(at("← /api/method")).toBeLessThan(at("satellite page's code"));
    expect(at("→ /api/agreement")).toBeGreaterThan(at("satellite page's code"));
    expect(requested().filter((path) => path === "/api/method")).toHaveLength(1);
  });
});
