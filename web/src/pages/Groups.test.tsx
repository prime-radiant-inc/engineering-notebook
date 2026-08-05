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

  test("dragging a session from panel 2 onto a group in panel 1 assigns it", async () => {
    vi.spyOn(api, "getGroups").mockResolvedValue({ groups: [{ id: 7, name: "Trading", sessionCount: 0, lastActivityAt: null }], desktopRunning: false });
    vi.spyOn(api, "getUngrouped").mockResolvedValue({
      sessions: [{ id: "s1", display_name: "Proj", project_id: "p", started_at: "2026-07-10T00:00:00Z", message_count: 3, title: "My Session", subagents: [] }],
      total: 1,
    });
    vi.spyOn(api, "getGroup").mockResolvedValue({ group: { id: 7, name: "Trading" }, sessions: [] });
    const assign = vi.spyOn(api, "assignSessionToGroup").mockResolvedValue();

    render(<TranscriptTogglesProvider><Groups /></TranscriptTogglesProvider>);

    // Open Ungrouped so the session row shows.
    fireEvent.click(await screen.findByText("Ungrouped"));
    const sessionRow = (await screen.findByText("My Session")).closest("button")!;
    const groupRow = screen.getByText("Trading").closest("button")!;

    // Simulate the drag with a minimal dataTransfer.
    const store: Record<string, string> = {};
    const dataTransfer = { setData: (k: string, v: string) => { store[k] = v; }, getData: (k: string) => store[k] || "", dropEffect: "", effectAllowed: "" };
    fireEvent.dragStart(sessionRow, { dataTransfer });
    fireEvent.dragOver(groupRow, { dataTransfer });
    fireEvent.drop(groupRow, { dataTransfer });

    await waitFor(() => expect(assign).toHaveBeenCalledWith("s1", 7));
  });

  test("dropping a session onto Ungrouped unassigns it (groupId null)", async () => {
    vi.spyOn(api, "getGroups").mockResolvedValue({ groups: [{ id: 7, name: "Trading", sessionCount: 1, lastActivityAt: null }], desktopRunning: false });
    vi.spyOn(api, "getUngrouped").mockResolvedValue({ sessions: [], total: 0 });
    vi.spyOn(api, "getGroup").mockResolvedValue({
      group: { id: 7, name: "Trading" },
      sessions: [{ id: "s1", display_name: "Proj", project_id: "p", started_at: "2026-07-10T00:00:00Z", message_count: 3, title: "My Session", subagents: [] }],
    });
    const assign = vi.spyOn(api, "assignSessionToGroup").mockResolvedValue();

    render(<TranscriptTogglesProvider><Groups /></TranscriptTogglesProvider>);

    fireEvent.click(await screen.findByText("Trading"));
    const sessionRow = (await screen.findByText("My Session")).closest("button")!;
    const ungroupedRow = screen.getByText("Ungrouped").closest("button")!;

    const store: Record<string, string> = {};
    const dataTransfer = { setData: (k: string, v: string) => { store[k] = v; }, getData: (k: string) => store[k] || "", dropEffect: "", effectAllowed: "" };
    fireEvent.dragStart(sessionRow, { dataTransfer });
    fireEvent.drop(ungroupedRow, { dataTransfer });

    await waitFor(() => expect(assign).toHaveBeenCalledWith("s1", null));
  });
});
