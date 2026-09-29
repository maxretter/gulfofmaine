import { createBrowserRouter } from "react-router";

import { BuoyPage } from "./pages/BuoyPage";
import { BuoysPage } from "./pages/BuoysPage";
import { DataPage } from "./pages/DataPage";
import { EventPage } from "./pages/EventPage";
import { EventsPage } from "./pages/EventsPage";
import { Layout, NotFound } from "./pages/Layout";
import { MethodsPage } from "./pages/MethodsPage";
import { NowPage } from "./pages/NowPage";
import { OriginsPage } from "./pages/OriginsPage";
import { SatellitePage } from "./pages/SatellitePage";

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <NowPage /> },
      { path: "buoys", element: <BuoysPage /> },
      { path: "buoys/:buoy", element: <BuoyPage /> },
      { path: "events", element: <EventsPage /> },
      { path: "events/:buoy/:depth/:start", element: <EventPage /> },
      { path: "origins", element: <OriginsPage /> },
      { path: "satellite", element: <SatellitePage /> },
      { path: "data", element: <DataPage /> },
      { path: "methods", element: <MethodsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
