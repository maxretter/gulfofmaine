import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError, keys, retry, useDaily, useDailyValues, useEvent } from "./queries";
import type { Day } from "./types";

/** Answers every request with `status`. */
function serve(status: number) {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ detail: "Not found" }), { status }));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

/** A heatwave's query on a client with the site's retry rule, and no wait between tries. */
function renderEvent() {
  const client = new QueryClient({ defaultOptions: { queries: { retry, retryDelay: 0 } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return renderHook(() => useEvent("B01", 50, "2021-06-10"), { wrapper });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("retry", () => {
  it("tries a network error or a 5xx three more times, and a 4xx never", () => {
    for (const error of [new TypeError("Failed to fetch"), new HttpError("/api/events", 503)]) {
      expect([0, 1, 2, 3].map((failures) => retry(failures, error))).toEqual([true, true, true, false]);
    }
    for (const status of [400, 404, 422]) expect(retry(0, new HttpError("/api/events", status))).toBe(false);
  });

  it("gives up on a missing heatwave at once", async () => {
    const fetch = serve(404);
    const { result } = renderEvent();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("asks again when the server fails", async () => {
    const fetch = serve(502);
    const { result } = renderEvent();

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

describe("useDailyValues", () => {
  it("asks for the means alone, kept apart from the full days but refreshed with them", async () => {
    const day: Day = { date: "2021-06-01", value: 12.5, climatology: 11, threshold: 13, anomaly: 1.5 };
    const fetch = vi.fn(async (url: string) => {
      const rows = url.includes("/daily/values?") ? [{ date: day.date, value: day.value }] : [day];
      return new Response(JSON.stringify(rows));
    });
    vi.stubGlobal("fetch", fetch);
    const client = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    // The range brush and the charts over the same days, as on a buoy's page showing its full record.
    const { result } = renderHook(
      () => ({
        values: useDailyValues("B01", 1, "2021-06-01", "2021-06-01"),
        days: useDaily("B01", 1, "2021-06-01", "2021-06-01"),
      }),
      { wrapper },
    );

    await waitFor(() => expect(result.current.values.isSuccess && result.current.days.isSuccess).toBe(true));
    const date = new Date("2021-06-01T00:00:00Z");
    expect(result.current.values.data).toEqual([{ date, value: 12.5 }]);
    expect(result.current.days.data).toEqual([{ ...day, date }]);
    expect(fetch.mock.calls.map(([url]) => url).sort()).toEqual([
      "/api/buoys/B01/1/daily/values?start=2021-06-01&end=2021-06-01",
      "/api/buoys/B01/1/daily?start=2021-06-01&end=2021-06-01&variable=temperature",
    ]);

    // As the live feed does with a message from B01.
    await act(() => client.invalidateQueries({ queryKey: [...keys.daily, "B01"] }));
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
