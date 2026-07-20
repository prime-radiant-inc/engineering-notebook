import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import Groups from "./Groups";
import { TranscriptTogglesProvider } from "../session/toggleContext";
import * as api from "../api";

describe("Groups (3-panel)", () => {
  beforeEach(() => vi.restoreAllMocks());

  test("selecting a session in a group reveals its subagent tasks nested beneath it", async () => {
    vi.spyOn(api, "getGroups").mockResolvedValue({ groups: [{ id: 1, name: "Trading", sessionCount: 1, lastActivityAt: "2026-07-10T00:00:00Z" }], desktopRunning: false });
    vi.spyOn(api, "getUngrouped").mockResolvedValue({ sessions: [], total: 0 });
    vi.spyOn(api, "getGroup").mockResolvedValue({
      group: { id: 1, name: "Trading" },
      sessions: [{
        id: "s1", display_name: "Proj", project_id: "p", started_at: "2026-07-10T00:00:00Z", message_count: 3, title: "Parent Session",
        subagents: [{ id: "agent-a1", agentType: "Explore", description: "dig into the schema" }],
      }],
    });
    vi.spyOn(api, "getSession").mockResolvedValue({
      id: "s1", project_id: "p", project_path: "/p", source_path: "/p/s1.jsonl", started_at: "t", ended_at: null,
      message_count: 3, git_branch: null, title: "Parent Session", title_source: null, parent_session_id: null, parent_title: null, subagents: [],
    });
    vi.spyOn(api, "getTranscript").mockResolvedValue({ format: "claude", messages: [{ role: "assistant", blocks: [{ kind: "text", content: "BODY" }] }] });

    render(<TranscriptTogglesProvider><Groups /></TranscriptTogglesProvider>);

    // Open the group → its session appears; subagent hidden until the session is selected.
    fireEvent.click(await screen.findByText("Trading"));
    const sessionBtn = await screen.findByText("Parent Session");
    expect(screen.queryByText("dig into the schema")).not.toBeInTheDocument();

    fireEvent.click(sessionBtn);
    const subBtn = await screen.findByText("dig into the schema");
    expect(subBtn.textContent).not.toMatch(/Explore/);
    // The subagent opens in panel 3.
    fireEvent.click(subBtn);
    await waitFor(() => expect(api.getSession).toHaveBeenCalledWith("agent-a1"));
  });
});
