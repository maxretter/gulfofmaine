// Shapes returned by the FastAPI backend (heatwaves/api.py). Dates are
// ISO strings ("2026-09-27"); timestamps are ISO datetimes in UTC.

export type State = "heatwave" | "above_threshold" | "normal" | "offline" | "no_data";

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
  category: number | null;
  category_name: string | null;
  event_start: string | null;
  synced_at: string | null;
  reading_at: string | null; // newest hourly reading; null for the satellite
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

/** Where a heatwave's heat likely came from (heatwaves/origin.py). Only heatwaves at 20 and 50 m have one. */
export type Origin = "offshore" | "surface" | "unclear";
export type Vote = "offshore" | "surface" | null;
export type Signal = "salinity" | "surface_heatwave" | "stratification" | "deep" | "onset_order";

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
}

/** The signals behind a heatwave's origin, and how each voted. Null where there was no data. */
export interface Evidence {
  salinity_anomaly: number | null; // at the event's depth, mean over the evidence window
  surface_heatwave_days: number | null; // at 1 m, in the 30 days before onset
  stratification_before: number | null; // 1 m minus the event's depth, °C, 30 days before
  stratification_after: number | null; // the same, onset to 14 days after
  deep_heatwave_days: number | null; // days M01 was in a heatwave at 100–250 m, 30 days before
  offshore_onset: string | null; // first onset at N01 or M01 at this depth, 90 days before
  western_onset: string | null; // the same at A01 or B01
  votes: Record<Signal, Vote>;
}

/** One day of the evidence window. */
export interface SignalDay {
  date: string;
  anomaly: number | null; // temperature at the event's depth minus normal, °C
  salinity_anomaly: number | null;
  stratification: number | null; // 1 m minus the event's depth, °C
  surface_heatwave: boolean;
  deep_anomaly: number | null; // M01, mean over 100–250 m, °C
  deep_heatwave: boolean;
}

export interface Onset {
  buoy_id: string;
  date: string;
  group: "offshore" | "western" | null;
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

/** One buoy's year at one depth, a value per day of `Onsets.dates`. */
export interface BuoyYear {
  buoy_id: string;
  onset: string | null; // its first heatwave starting in the year
  origin: Origin | null; // of that heatwave
  anomaly: (number | null)[];
  heatwave: boolean[];
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

export interface YearSummary {
  buoy_id: string;
  depth: number;
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

/** A series entered or left a heatwave, or its state or category changed. Depth 0 is the satellite. */
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
