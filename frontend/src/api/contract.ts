// types.ts held to the API's own types, schema.ts, generated from its pydantic models and routes
// (scripts/api_types.py). The type check fails here unless each of the app's types and the API's are assignable to
// each other, so a field renamed, added, dropped, retyped or made nullable on either side fails it, as does a value
// added to or dropped from a union such as State. It can't tell a date from a datetime, or an integer from a float:
// both sides have only strings and numbers. It fails too for a path the app fetches that the API doesn't serve, or
// whose route sends another model than the app expects.
import type * as Api from "./schema";
import type * as App from "./types";

/** Type-checks only if A and B are each assignable to the other. */
type Same<A extends B, B extends Back, Back = A> = [A, B];

// The API's votes and reasons are dicts by signal, where types.ts names the five signals it always sends
// (heatwaves.origin.SIGNALS), so they're compared by their values alone.
type Evidence = Omit<Api.Evidence, "votes"> & Pick<App.Evidence, "votes">;
type Reasons = Omit<Api.Reasons, "signals"> & Pick<App.Reasons, "signals">;
type EventDetail = Omit<Api.EventDetail, "evidence" | "reasons"> & { evidence: Evidence | null; reasons: Reasons | null };

// What the API's route for each path the app fetches sends: indexing Paths by a path it lacks fails the type check.
// A heatwave's detail is compared with its votes by value, as above.
type Responses = {
  [Path in keyof App.Responses]: Api.Paths[Path]["response"] extends Api.EventDetail
    ? EventDetail
    : Api.Paths[Path]["response"];
};

export type Contract = [
  Same<App.Condition, Api.Condition>,
  Same<App.SatelliteCondition, Api.SatelliteCondition>,
  Same<App.Buoy, Api.BuoyOut>,
  Same<App.Day, Api.Day>,
  Same<App.DayValue, Api.DayValue>,
  Same<App.HeatwaveEvent, Api.EventOut>,
  Same<App.Evidence, Evidence>,
  Same<App.Evidence["votes"][App.Signal], Api.Evidence["votes"][string]>,
  Same<App.Reasons, Reasons>,
  Same<App.Reasons["signals"][App.Signal], Api.Reasons["signals"][string]>,
  Same<App.SignalDay, Api.SignalDay>,
  Same<App.Onset, Api.Onset>,
  Same<App.EventDetail, EventDetail>,
  Same<App.OriginRules, Api.OriginRules>,
  Same<App.Method, Api.Method>,
  Same<App.BuoyYear, Api.BuoyYear>,
  Same<App.Onsets, Api.Onsets>,
  Same<App.Agreement, Api.Agreement>,
  Same<App.MonthAnomaly, Api.MonthAnomaly>,
  Same<App.YearSummary, Api.YearSummary>,
  Same<App.ReadingMessage, Api.ReadingMessage>,
  Same<App.StatusMessage, Api.StatusMessage>,
  Same<App.JudgedHeatwave, Api.JudgedHeatwave>,
  Same<App.OriginsMessage, Api.OriginsMessage>,
  Same<App.DaysMessage, Api.DaysMessage>,
  Same<App.RecomputedMessage, Api.RecomputedMessage>,
  Same<App.PingMessage, Api.PingMessage>,
  Same<App.DataFile, Api.DataFile>,
  Same<App.DataProduct, Api.DataProduct>,
  Same<App.DataVariable, Api.DataVariable>,
  Same<App.DataCatalog, Api.DataCatalog>,
  Same<App.Responses, Responses>,
];
