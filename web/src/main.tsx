import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, Outlet, useParams } from "react-router-dom";
import "./index.css";
import { AppShell } from "./components/AppShell";
import Journal from "./pages/Journal";
import Placeholder from "./pages/Placeholder";
import { SessionView } from "./components/SessionView";

function SessionRoute() {
  const { id = "" } = useParams();
  return (
    <div className="h-full overflow-y-auto p-6">
      <SessionView id={id} />
    </div>
  );
}

const router = createBrowserRouter([
  {
    element: (
      <AppShell>
        <Outlet />
      </AppShell>
    ),
    children: [
      { path: "/", element: <Journal /> },
      { path: "/projects", element: <Placeholder title="Projects" /> },
      { path: "/calendar", element: <Placeholder title="Calendar" /> },
      { path: "/groups", element: <Placeholder title="Groups" /> },
      { path: "/s/:id", element: <SessionRoute /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
