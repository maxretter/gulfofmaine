// The API's answers on the production site, saved on Oct 1, 2026, for tests to check the pages' text against: a
// sentence built from the data should read as it did when it was written out by hand. /api/method and
// /api/origin/rules hold only what the code fixes, so theirs are written by the code itself (heatwaves/api.py).
import type { Agreement, Buoy, HeatwaveEvent, Method, OriginRules } from "../api/types";
import agreement1 from "./production/agreement_1.json";
import agreement20 from "./production/agreement_20.json";
import agreement50 from "./production/agreement_50.json";
import buoysJson from "./production/buoys.json";
import eventsJson from "./production/events.json";
import methodJson from "./production/method.json";
import rulesJson from "./production/origin-rules.json";

export const buoys = buoysJson as Buoy[];
export const events = eventsJson as HeatwaveEvent[];
export const method = methodJson as Method;
export const rules = rulesJson as OriginRules;
/** /api/agreement, by depth. */
export const agreements: Record<number, Agreement[]> = { 1: agreement1, 20: agreement20, 50: agreement50 };
