import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// In development, Vite serves the app and forwards API requests to FastAPI
// (uvicorn on :8000), so the browser sees a single origin, as in production.
// The live feed's WebSocket, /api/live, goes the same way.
const api = process.env.API_URL ?? "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": { target: api, ws: true },
      "/docs": api,
      "/openapi.json": api,
      "/healthz": api,
    },
  },
  build: {
    rolldownOptions: {
      output: {
        // Libraries change far less often than the app, so they get their own
        // long-cached chunks: a deploy that only touches app code stays small.
        codeSplitting: {
          groups: [
            { name: "plot", test: /node_modules[\\/](@observablehq|d3|d3-[^\\/]+|internmap|delaunator|robust-predicates|interval-tree-1d|isoformat)[\\/]/ },
            { name: "leaflet", test: /node_modules[\\/](leaflet|react-leaflet|@react-leaflet)[\\/]/ },
            { name: "react", test: /node_modules[\\/](react|react-dom|react-router|scheduler|@tanstack|cookie|set-cookie-parser)[\\/]/ },
          ],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
  },
});
