import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import "./index.css";
import SessionList from "./pages/SessionList";
import SessionDetail from "./pages/SessionDetail";

const router = createBrowserRouter([
  { path: "/", element: <SessionList /> },
  { path: "/s/:id", element: <SessionDetail /> },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
