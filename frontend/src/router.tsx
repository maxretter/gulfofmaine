import { createBrowserRouter, type RouteObject } from "react-router";

import { AboutPage, MovedToAbout } from "./pages/AboutPage";
import { BuoyPage } from "./pages/BuoyPage";
import { BuoysPage } from "./pages/BuoysPage";
import { EventPage } from "./pages/EventPage";
import { EventsPage } from "./pages/EventsPage";
import { ErrorPage, Layout, NotFound } from "./pages/Layout";
import { NowPage } from "./pages/NowPage";
import { OriginsPage } from "./pages/OriginsPage";
import { SatellitePage } from "./pages/SatellitePage";

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
        children: [
          { index: true, element: <NowPage /> },
          { path: "buoys", element: <BuoysPage /> },
          { path: "buoys/:buoy", element: <BuoyPage /> },
          { path: "events", element: <EventsPage /> },
          { path: "events/:buoy/:depth/:start", element: <EventPage /> },
          { path: "origins", element: <OriginsPage /> },
          { path: "satellite", element: <SatellitePage /> },
          { path: "about", element: <AboutPage /> },
          { path: "methods", element: <MovedToAbout /> },
          { path: "data", element: <MovedToAbout section="data" /> },
          { path: "*", element: <NotFound /> },
        ],
      },
    ],
  },
];

export const router = createBrowserRouter(routes);
