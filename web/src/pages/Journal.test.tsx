import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
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
        { id: 1, date: "2026-07-15", project_id: "p", display_name: "My Project", headline: "Built the thing", summary: "Did a lot", topics: ["infra"], open_questions: ["what next?"], session_ids: ["s1"] },
      ],
    });
    vi.spyOn(api, "getSession").mockResolvedValue({
      id: "s1", project_id: "p", project_path: "/p", source_path: "/p/s1.jsonl",
      started_at: "2026-07-15T00:00:00Z", ended_at: null, message_count: 1, subagents: [],
    });
    vi.spyOn(api, "getTranscript").mockResolvedValue({ format: "claude", messages: [{ role: "assistant", blocks: [{ kind: "text", content: "TRANSCRIPT_TEXT" }] }] });

    render(<Journal />);

    // panel 2: the Claude summary auto-loaded for the first date (headline is unique)
    await screen.findByText("Built the thing");
    expect(screen.getAllByText("2026-07-15").length).toBeGreaterThan(0); // panel 1 date + panel 2 header
    expect(screen.getByText("Did a lot")).toBeInTheDocument();
    expect(screen.getByText("infra")).toBeInTheDocument();
    expect(screen.getByText("what next?")).toBeInTheDocument();

    // panel 3 empty until a session is chosen
    expect(screen.getByText(/Select a session/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("session 1"));
    await waitFor(() => expect(screen.getByText("TRANSCRIPT_TEXT")).toBeInTheDocument());
  });
});
