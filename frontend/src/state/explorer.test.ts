import { describe, expect, it } from "vitest";

import { parseExplorerParams, toSearchParams } from "./explorer";

const parse = (query: string) => parseExplorerParams(new URLSearchParams(query));

describe("explorer URL state", () => {
  it("reads a full view", () => {
    expect(parse("buoy=f01&depth=20&from=2021-05-01&to=2021-12-31")).toEqual({
      buoy: "F01",
      depth: 20,
      from: "2021-05-01",
      to: "2021-12-31",
    });
  });

  it("falls back to defaults for anything it can't use", () => {
    expect(parse("buoy=<script>&depth=deep&from=2021-02-30&to=2021-12-31")).toEqual({
      buoy: null,
      depth: 1,
      from: null,
      to: null,
    });
  });

  it("takes any depth a buoy might have, not just the map's", () => {
    expect(parse("buoy=M01&depth=150").depth).toBe(150);
    expect(parse("depth=-20").depth).toBe(1);
    expect(parse("depth=2.5").depth).toBe(1);
  });

  it("puts a reversed range the right way round", () => {
    expect(parse("from=2022-01-01&to=2021-01-01")).toMatchObject({ from: "2021-01-01", to: "2022-01-01" });
  });

  it("writes only what differs from the defaults, and reads back what it wrote", () => {
    const state = { buoy: "B01", depth: 1, from: "2012-01-01", to: "2012-12-31" };
    const params = toSearchParams(state);
    expect(params.toString()).toBe("buoy=B01&from=2012-01-01&to=2012-12-31");
    expect(parseExplorerParams(params)).toEqual(state);
  });
});
