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
}

/** Satellite sea surface temperature at a buoy (depth 0), from the nearest grid cell with data. */
export interface SatelliteCondition extends Condition {
  latitude: number | null; // the cell's centre
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

export interface Day {
  date: string;
  temperature: number | null;
  climatology: number;
  threshold: number;
}

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
