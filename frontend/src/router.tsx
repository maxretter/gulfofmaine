import { createBrowserRouter } from "react-router";

import { EventsPage } from "./pages/EventsPage";
import { ExplorerPage } from "./pages/ExplorerPage";
import { Layout, NotFound } from "./pages/Layout";
import { MethodsPage } from "./pages/MethodsPage";

export const router = createBrowserRouter([
  {
    element: <Layout />,
    children: [
      { index: true, element: <ExplorerPage /> },
      { path: "events", element: <EventsPage /> },
      { path: "methods", element: <MethodsPage /> },
      { path: "*", element: <NotFound /> },
    ],
  },
]);
