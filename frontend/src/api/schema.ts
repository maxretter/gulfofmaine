// The API's JSON, generated from its OpenAPI schema and the live feed's messages by scripts/api_types.py:
// don't edit it, but run `uv run python -m scripts.api_types` after changing a response model. The app uses
// the names in types.ts, which contract.ts checks against these.

export interface Agreement {
  buoy_id: string;
  depth: number;
  year: number;
  both: number;
  satellite_only: number;
  buoy_only: number;
  neither: number;
}

export interface BuoyOut {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  series: Condition[];
  satellite: SatelliteCondition | null;
}

export interface BuoyYear {
  buoy_id: string;
  heatwaves: EventOut[];
  anomaly: (number | null)[];
  heatwave: (string | null)[];
}

export interface Condition {
  depth: number;
  dataset_id: string;
  erddap_url: string;
  state: "heatwave" | "paused" | "above_threshold" | "normal" | "no_normal" | "offline" | "no_data";
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
  reading_at: string | null;
  reading: number | null;
}

export interface DataCatalog {
  products: DataProduct[];
  variables: DataVariable[];
}

export interface DataFile {
  format: "nc" | "csv";
  url: string;
  size: number;
  modified: string;
}

export interface DataProduct {
  name: string;
  buoy_id: string | null;
  depth: number | null;
  files: DataFile[];
}

export interface DataVariable {
  name: string;
  long_name: string;
  units: string | null;
  standard_name: string | null;
  flag_meanings: string | null;
}

export interface Day {
  date: string;
  value: number | null;
  climatology: number;
  threshold: number;
  anomaly: number | null;
}

export interface DayValue {
  date: string;
  value: number | null;
}

export interface EventDetail {
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
  origin: "offshore" | "surface" | "unclear" | null;
  status: "ongoing" | "paused" | "ended";
  evidence: Evidence | null;
  signals: SignalDay[];
  onsets: Onset[];
}

export interface EventOut {
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
  origin: "offshore" | "surface" | "unclear" | null;
  status: "ongoing" | "paused" | "ended";
}

export interface Evidence {
  salinity_anomaly: number | null;
  surface_heatwave_days: number | null;
  stratification_before: number | null;
  stratification_after: number | null;
  deep_heatwave_days: number | null;
  offshore_onset: string | null;
  western_onset: string | null;
  votes: Record<string, "offshore" | "surface" | null>;
}

export interface HTTPValidationError {
  detail?: ValidationError[];
}

export interface Method {
  baseline_start: number;
  baseline_end: number;
  percentile: number;
  window_half_width: number;
  smooth_width: number;
  min_duration: number;
  max_gap: number;
  max_pad: number;
  categories: string[];
  min_hours: number;
  offline_after: number;
  depths: number[];
}

export interface MonthAnomaly {
  month: string;
  anomaly: number;
  buoys: number;
}

export interface Onset {
  buoy_id: string;
  date: string;
  group: "offshore" | "western" | null;
}

export interface Onsets {
  year: number;
  depth: number;
  dates: string[];
  buoys: BuoyYear[];
}

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

export interface PingMessage {
  type: "ping";
  time: string;
}

export interface ReadingMessage {
  type: "reading";
  buoy: string;
  depth: number;
  time: string;
  temperature: number;
}

export interface SatelliteCondition {
  depth: number;
  dataset_id: string;
  erddap_url: string;
  state: "heatwave" | "paused" | "above_threshold" | "normal" | "no_normal" | "offline" | "no_data";
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
  reading_at: string | null;
  reading: number | null;
  latitude: number | null;
  longitude: number | null;
  distance_km: number | null;
}

export interface SignalDay {
  date: string;
  anomaly: number | null;
  salinity_anomaly: number | null;
  stratification: number | null;
  surface_anomaly: number | null;
  surface_heatwave: boolean;
  deep_anomaly: number | null;
  deep_heatwave: boolean;
}

export interface StatusMessage {
  type: "status";
  buoy: string;
  depth: number;
  date: string | null;
  state: "heatwave" | "paused" | "above_threshold" | "normal" | "no_normal" | "offline" | "no_data";
  category: number | null;
  days_above: number;
  previous_state: "heatwave" | "paused" | "above_threshold" | "normal" | "no_normal" | "offline" | "no_data";
  previous_category: number | null;
}

export interface ValidationError {
  loc: (string | number)[];
  msg: string;
  type: string;
  input?: unknown;
  ctx?: Record<string, unknown>;
}

export interface YearSummary {
  buoy_id: string;
  depth: number | null;
  year: number;
  heatwave_days: number;
  observed_days: number;
}
