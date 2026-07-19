import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import SessionList from "./SessionList";
import * as api from "../api";

describe("SessionList", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("renders sessions with links to detail", async () => {
    vi.spyOn(api, "getSessions").mockResolvedValue({
      total: 2,
      sessions: [
        { id: "s1", project_id: "proj", display_name: "First session", started_at: "2026-07-10T00:00:00Z", ended_at: null, message_count: 5, is_subagent: 0 },
        { id: "s2", project_id: "proj", display_name: "Second session", started_at: "2026-07-09T00:00:00Z", ended_at: null, message_count: 3, is_subagent: 0 },
      ],
    });

    render(<MemoryRouter><SessionList /></MemoryRouter>);

    const first = await screen.findByText("First session");
    expect(first).toBeInTheDocument();
    expect(screen.getByText("Second session")).toBeInTheDocument();
    expect(first.closest("a")).toHaveAttribute("href", "/s/s1");
    await waitFor(() => expect(screen.getByText("2 of 2")).toBeInTheDocument());
  });

  test("shows an error when the API fails", async () => {
    vi.spyOn(api, "getSessions").mockRejectedValue(new Error("boom"));
    render(<MemoryRouter><SessionList /></MemoryRouter>);
    expect(await screen.findByText(/Failed to load: boom/)).toBeInTheDocument();
  });
});
