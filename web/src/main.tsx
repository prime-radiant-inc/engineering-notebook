import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider, Outlet, useParams } from "react-router-dom";
import "./index.css";
import { AppShell } from "./components/AppShell";
import Journal from "./pages/Journal";
import Projects from "./pages/Projects";
import Calendar from "./pages/Calendar";
import Groups from "./pages/Groups";
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
      { path: "/projects", element: <Projects /> },
      { path: "/calendar", element: <Calendar /> },
      { path: "/groups", element: <Groups /> },
      { path: "/s/:id", element: <SessionRoute /> },
    ],
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
