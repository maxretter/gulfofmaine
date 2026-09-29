import { createBrowserRouter } from "react-router";

import { DataPage } from "./pages/DataPage";
import { EventPage } from "./pages/EventPage";
import { EventsPage } from "./pages/EventsPage";
import { ExplorerPage } from "./pages/ExplorerPage";
import { Layout, NotFound } from "./pages/Layout";
import { MethodsPage } from "./pages/MethodsPage";
import { OriginsPage } from "./pages/OriginsPage";

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <ExplorerPage /> },
      { path: "events", element: <EventsPage /> },
      { path: "events/:buoy/:depth/:start", element: <EventPage /> },
      { path: "origins", element: <OriginsPage /> },
      { path: "data", element: <DataPage /> },
      { path: "methods", element: <MethodsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
