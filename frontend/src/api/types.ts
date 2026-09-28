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

export interface Buoy {
  id: string;
  name: string;
  latitude: number | null;
  longitude: number | null;
  series: Condition[];
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

export interface YearSummary {
  buoy_id: string;
  depth: number;
  year: number;
  heatwave_days: number;
  observed_days: number;
}
