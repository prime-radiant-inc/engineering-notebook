import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TranscriptTogglesProvider } from "../session/toggleContext";
import Journal from "./Journal";
import * as api from "../api";

describe("Journal (3-panel)", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("shows dates, loads entries for the first date, and opens a session in panel 3", async () => {
    vi.spyOn(api, "getJournalDates").mockResolvedValue({
      dates: [{ date: "2026-07-15", projects: ["My Project"] }],
    });
    vi.spyOn(api, "getJournalEntries").mockResolvedValue({
      entries: [
        { id: 1, date: "2026-07-15", project_id: "p", display_name: "My Project", headline: "Built the thing", summary: "Did a lot", topics: ["infra"], open_questions: ["what next?"], session_ids: ["s1"], sessions: [{ id: "s1", title: null, subagents: [] }] },
      ],
    });
    vi.spyOn(api, "getSession").mockResolvedValue({
      id: "s1", project_id: "p", project_path: "/p", source_path: "/p/s1.jsonl",
      started_at: "2026-07-15T00:00:00Z", ended_at: null, message_count: 1, git_branch: null, title: null, title_source: null, parent_session_id: null, parent_title: null, subagents: [],
    });
    vi.spyOn(api, "getTranscript").mockResolvedValue({ format: "claude", messages: [{ role: "assistant", blocks: [{ kind: "text", content: "TRANSCRIPT_TEXT" }] }] });

    render(<MemoryRouter><TranscriptTogglesProvider><Journal /></TranscriptTogglesProvider></MemoryRouter>);

    // panel 2: the Claude summary auto-loaded for the first date (headline is unique)
    await screen.findByText("Built the thing");
    expect(screen.getAllByText("2026-07-15").length).toBeGreaterThan(0); // panel 1 date + panel 2 header
    expect(screen.getByText("Did a lot")).toBeInTheDocument();
    expect(screen.getByText("infra")).toBeInTheDocument();
    expect(screen.getByText("what next?")).toBeInTheDocument();

    // panel 3 empty until a session is chosen
    expect(screen.getByText(/Select a session/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Session 1"));
    await waitFor(() => expect(screen.getByText("TRANSCRIPT_TEXT")).toBeInTheDocument());
  });

  test("nests subagents under a session and opens one, showing the backlink to the parent", async () => {
    vi.spyOn(api, "getJournalDates").mockResolvedValue({ dates: [{ date: "2026-07-15", projects: ["My Project"] }] });
    vi.spyOn(api, "getJournalEntries").mockResolvedValue({
      entries: [
        { id: 1, date: "2026-07-15", project_id: "p", display_name: "My Project", headline: "Built the thing", summary: "s", topics: [], open_questions: [], session_ids: ["s1"],
          sessions: [{ id: "s1", title: "Parent Session", subagents: [{ id: "agent-a1", agentType: "general-purpose", description: "investigate endpoint" }] }] },
      ],
    });
    vi.spyOn(api, "getSession").mockImplementation(async (id: string) => (
      id === "agent-a1"
        ? { id: "agent-a1", project_id: "p", project_path: "/p", source_path: "/p/s1/subagents/agent-a1.jsonl", started_at: "t", ended_at: null, message_count: 1, git_branch: null, title: null, title_source: null, is_subagent: 1, parent_session_id: "s1", parent_title: "Parent Session", subagents: [] }
        : { id: "s1", project_id: "p", project_path: "/p", source_path: "/p/s1.jsonl", started_at: "t", ended_at: null, message_count: 1, git_branch: null, title: "Parent Session", title_source: null, parent_session_id: null, parent_title: null, subagents: [] }
    ));
    vi.spyOn(api, "getTranscript").mockResolvedValue({ format: "claude", messages: [{ role: "assistant", blocks: [{ kind: "text", content: "SUBAGENT_BODY" }] }] });

    render(<MemoryRouter><TranscriptTogglesProvider><Journal /></TranscriptTogglesProvider></MemoryRouter>);

    // Subagents are hidden until the parent session is selected.
    const parentBtn = await screen.findByText("Parent Session");
    expect(screen.queryByText("investigate endpoint")).not.toBeInTheDocument();
    fireEvent.click(parentBtn);

    // Now the subagent appears nested under its parent, labelled by title only (no agent type).
    const subBtn = await screen.findByText("investigate endpoint");
    expect(subBtn.textContent).not.toMatch(/general-purpose/);
    fireEvent.click(subBtn);

    // Panel 3 shows the subagent's transcript and a backlink to the parent.
    await waitFor(() => expect(screen.getByText("SUBAGENT_BODY")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: /Subagent of.*Parent Session/ })).toBeInTheDocument();
  });
});
