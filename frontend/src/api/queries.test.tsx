import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { HttpError, retry, useEvent } from "./queries";

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
