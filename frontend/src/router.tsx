import { createBrowserRouter, type RouteObject } from "react-router";

import { ErrorPage, Layout, NotFound } from "./pages/Layout";

// Each page is loaded when it's first visited, so a route downloads only the code it draws with: Leaflet for the
// front page's map, Plot for the charts. A link to a page not loaded yet keeps the current one up, dimmed (Layout),
// until it has.
export const routes: RouteObject[] = [
  {
    element: <Layout />,
    // A page that fails shows the error under the site's header; a header that fails, on its own.
    errorElement: (
      <main className="wrap">
        <ErrorPage />
      </main>
    ),
    children: [
      {
        errorElement: <ErrorPage />,
        // Under the header while the first page loads.
        hydrateFallbackElement: <p className="note">Loading…</p>,
        children: [
          { index: true, lazy: async () => ({ Component: (await import("./pages/NowPage")).NowPage }) },
          { path: "buoys", lazy: async () => ({ Component: (await import("./pages/BuoysPage")).BuoysPage }) },
          { path: "buoys/:buoy", lazy: async () => ({ Component: (await import("./pages/BuoyPage")).BuoyPage }) },
          { path: "events", lazy: async () => ({ Component: (await import("./pages/EventsPage")).EventsPage }) },
          {
            path: "events/:buoy/:depth/:start",
            lazy: async () => ({ Component: (await import("./pages/EventPage")).EventPage }),
          },
          { path: "origins", lazy: async () => ({ Component: (await import("./pages/OriginsPage")).OriginsPage }) },
          {
            path: "satellite",
            lazy: async () => ({ Component: (await import("./pages/SatellitePage")).SatellitePage }),
          },
          { path: "about", lazy: async () => ({ Component: (await import("./pages/AboutPage")).AboutPage }) },
          {
            path: "methods",
            lazy: async () => {
              const { MovedToAbout } = await import("./pages/AboutPage");
              return { element: <MovedToAbout /> };
            },
          },
          {
            path: "data",
            lazy: async () => {
              const { MovedToAbout } = await import("./pages/AboutPage");
              return { element: <MovedToAbout section="data" /> };
            },
          },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
