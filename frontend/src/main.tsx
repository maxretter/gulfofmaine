import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/public-sans";
import "leaflet/dist/leaflet.css";
import "./styles.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";

import { retry } from "./api/queries";
import { router } from "./router";

// The live feed invalidates whatever it changes (api/live.ts), so cached responses otherwise stay fresh for five minutes.
const queryClient = new QueryClient({
  defaultOptions: { queries: { staleTime: 5 * 60_000, refetchOnWindowFocus: false, retry } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
