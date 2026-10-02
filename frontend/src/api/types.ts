// Shapes returned by the FastAPI backend (heatwaves/api.py). Dates are
// ISO strings ("2026-09-27"); timestamps are ISO datetimes in UTC.
// contract.ts holds them to the API's own types (schema.ts): the type check
// fails if one drifts from what the API sends.

// "paused": the newest day isn't in a heatwave, but the days since the last one, a dip below the threshold and
// perhaps a run back above it, could still be joined to it (heatwaves/state.py); category and event_start are that
// heatwave's. "no_normal": reporting, but with too little data in the baseline for a normal, so neither in a
// heatwave nor out of one.
export type State = "heatwave" | "paused" | "above_threshold" | "normal" | "no_normal" | "offline" | "no_data";

export interface Condition {
  depth: number;
  dataset_id: string;
  erddap_url: string;
  state: State;
  first_date: string | null;
  date: string | null;
  temperature: number | null;
  climatology: number | null;
  anomaly: number | null;
  threshold: number | null;
  days_above: number;
  category: number | null; // of the heatwave in progress or paused
  category_name: string | null;
  event_start: string | null;
  synced_at: string | null;
  reading_at: string | null; // newest reading that passed quality control; null for the satellite
  reading: number | null;
}

/** Satellite sea surface temperature at a buoy (depth 0), from the nearest grid cell with data. */
export interface SatelliteCondition extends Condition {
  latitude: number | null; // the cell's center
  longitude: number | null;
  distance_km: number | null; // from the buoy
}

export interface Buoy {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  series: Condition[]; // buoy depths, shallowest first
  satellite: SatelliteCondition | null;
}

export type Variable = "temperature" | "salinity";

/** A daily mean beside its normal and heatwave threshold: degrees C, or practical salinity. */
export interface Day {
  date: string;
  value: number | null; // null when the day has too little data
  climatology: number;
  threshold: number;
  anomaly: number | null; // value minus climatology
}

/** A daily mean alone, without its normal (/daily/values): a whole record in a third of the bytes. */
export type DayValue = Pick<Day, "date" | "value">;

/** Where a heatwave's heat likely came from (heatwaves/origin.py). Only heatwaves at 20 and 50 m have one. */
export type Origin = "offshore" | "surface" | "unclear";
export type Vote = "offshore" | "surface" | null;
export type Signal = "salinity" | "surface_heatwave" | "stratification" | "deep" | "onset_order";

/**
 * Whether a heatwave is over, by its series' state today (heatwaves/state.py): "ongoing" while the series is in it,
 * "paused" while the series is paused on it, else "ended". Until it has ended, all but its start are so far.
 */
export type EventStatus = "ongoing" | "paused" | "ended";

export interface HeatwaveEvent {
  buoy_id: string;
  depth: number;
  start_date: string;
  end_date: string;
  peak_date: string;
  duration: number;
  max_intensity: number;
  mean_intensity: number;
  category: number;
  category_name: string;
  origin: Origin | null;
  status: EventStatus;
}

/** The signals behind a heatwave's origin, and how each voted. Null where there was no data. */
export interface Evidence {
  salinity_anomaly: number | null; // at the event's depth, mean over the evidence window
  surface_heatwave_days: number | null; // at 1 m, in the 30 days before onset
  stratification_before: number | null; // 1 m minus the event's depth, °C, 30 days before
  stratification_after: number | null; // the same, onset to 14 days after
  deep_heatwave_days: number | null; // days M01 was in a heatwave at 100–250 m, 30 days before
  offshore_onset: string | null; // first onset at N01 or M01 at this depth, 90 days before
  western_onset: string | null; // the same at A01 or B01; neither counts the event's own buoy
  votes: Record<Signal, Vote>;
}

/** One day of the evidence window. */
export interface SignalDay {
  date: string;
  anomaly: number | null; // temperature at the event's depth minus normal, °C
  salinity_anomaly: number | null;
  stratification: number | null; // 1 m minus the event's depth, °C
  surface_anomaly: number | null; // at 1 m, °C
  surface_heatwave: boolean; // at 1 m
  deep_anomaly: number | null; // M01, mean over 100–250 m, °C
  deep_heatwave: boolean;
}

export interface Onset {
  buoy_id: string;
  date: string;
  group: "offshore" | "western" | null; // the onset order's side it counts for; null at the heatwave's own buoy
}

export interface EventDetail extends HeatwaveEvent {
  evidence: Evidence | null;
  signals: SignalDay[]; // 30 days before onset to 14 after; empty without an origin
  onsets: Onset[]; // every buoy's onsets at this depth in the 90 days to this one
}

/** The thresholds the origin labels come from, served by the API so the page can't drift from the code. */
export interface OriginRules {
  depths: number[];
  before: number;
  after: number;
  lookback: number;
  min_days: number;
  salty: number;
  fresh: number;
  drift: number;
  mixed: number;
  collapse: number;
  together: number;
  margin: number;
  offshore_buoys: string[];
  western_buoys: string[];
  deep_buoy: string;
  deep_depths: number[];
}

/**
 * What the pages state the method with: heatwave detection's parameters (heatwaves/hobday.py), the hours a daily mean
 * needs, when a series is offline, and the depths the map shows. Served by the API so the pages use the code's numbers.
 */
export interface Method {
  baseline_start: number; // first year of the baseline the normal and threshold come from
  baseline_end: number; // its last year
  percentile: number; // of the baseline's temperatures for the time of year: the threshold
  window_half_width: number; // days either side of each day of the year pooled into its normal and threshold
  smooth_width: number; // days in the running mean that smooths the normal and threshold
  min_duration: number; // days in a row above the threshold that make a heatwave
  max_gap: number; // days: heatwaves this many days apart or fewer are joined into one
  max_pad: number; // days: gaps in the data this long or shorter are filled in; a longer one ends a heatwave
  categories: string[]; // names, category 1 first
  min_hours: number; // hours with a reading a day needs for its daily mean
  offline_after: number; // days: a series whose newest daily mean is older than this is offline
  depths: number[]; // meters: those every buoy has, which the map shows, shallowest first
}

/** One buoy's year at one depth: its heatwaves, and a value per day of `Onsets.dates`. */
export interface BuoyYear {
  buoy_id: string;
  heatwaves: HeatwaveEvent[]; // running in the year, oldest first: one carried over from the year before too
  anomaly: (number | null)[];
  heatwave: (string | null)[]; // the start date of the heatwave each day was part of
}

export interface Onsets {
  year: number;
  depth: number;
  dates: string[];
  buoys: BuoyYear[];
}

/** Days in a year with data at both a buoy depth and the satellite, by which saw a heatwave. */
export interface Agreement {
  buoy_id: string;
  depth: number;
  year: number;
  both: number;
  satellite_only: number;
  buoy_only: number;
  neither: number;
}

/** One month's temperature against normal at a depth, averaged over the buoys (/api/stripes). */
export interface MonthAnomaly {
  month: string; // its first day
  anomaly: number; // °C
  buoys: number;
}

/** Heatwave days and observed days in a year at a buoy (/api/annual). */
export interface YearSummary {
  buoy_id: string;
  depth: number | null; // null: every depth
  year: number;
  heatwave_days: number;
  observed_days: number;
}

/** Messages on the live feed at /api/live (heatwaves/live.py). */
export interface ReadingMessage {
  type: "reading";
  buoy: string;
  depth: number;
  time: string;
  temperature: number;
}

/**
 * A series' state changed, or its heatwave in progress or paused did (its dates, category or intensity). A heatwave
 * that only grew or changed has "heatwave" as both states; a paused one that changed, "paused". A heatwave that dips
 * below the threshold is "paused" while what follows could still be joined to it, and "heatwave" again, the same one,
 * if it is. Depth 0 is the satellite.
 */
export interface StatusMessage {
  type: "status";
  buoy: string;
  depth: number;
  date: string | null;
  state: State;
  category: number | null;
  days_above: number;
  previous_state: State;
  previous_category: number | null;
}

export interface PingMessage {
  type: "ping";
  time: string;
}

export type LiveMessage = ReadingMessage | StatusMessage | PingMessage;

/** A product file the sync job writes, from GET /api/data. */
export interface DataFile {
  format: "nc" | "csv";
  url: string;
  size: number; // bytes
  modified: string; // ISO datetime, UTC
}

export interface DataProduct {
  name: string; // file name without extension, e.g. A01_heatwaves_020m
  buoy_id: string | null; // null for the events table
  depth: number | null;
  files: DataFile[];
}

/** A variable of the daily series files, from its NetCDF attributes. */
export interface DataVariable {
  name: string;
  long_name: string;
  units: string | null;
  standard_name: string | null;
  flag_meanings: string | null; // space-separated, for flag values 0, 1, 2 ...
}

export interface DataCatalog {
  products: DataProduct[];
  variables: DataVariable[];
}
