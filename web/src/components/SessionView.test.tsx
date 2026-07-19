import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionView } from "./SessionView";
import { TranscriptTogglesProvider, TranscriptToggleButtons } from "../session/toggleContext";
import * as api from "../api";

function renderView(id: string) {
  return render(
    <TranscriptTogglesProvider>
      <TranscriptToggleButtons />
      <SessionView id={id} />
    </TranscriptTogglesProvider>,
  );
}

describe("SessionView (ported viewer)", () => {
  beforeEach(() => vi.restoreAllMocks());

  const meta: api.SessionMeta = {
    id: "s1", project_id: "proj", project_path: "/p", source_path: "/p/s1.jsonl",
    started_at: "2026-07-10T00:00:00Z", ended_at: null, message_count: 3, git_branch: null, title: null,
    subagents: [{ agentId: "ag1", description: "do a thing", agentType: "general-purpose", toolUseId: "tu1", spawnDepth: 1 }],
  };
  const transcript: api.Transcript = {
    format: "claude",
    messages: [
      { role: "assistant", model: "claude-sonnet-5", blocks: [
        { kind: "thinking", content: "SECRET_REASONING" },
        { kind: "text", content: "the answer" },
        { kind: "tool_use", id: "tub", name: "Bash", input: { command: "ls -la" }, content: "{}" },
        { kind: "tool_use", id: "tu1", name: "Task", input: { description: "do a thing", subagent_type: "general-purpose" }, content: "{}" },
      ] },
      { role: "user", blocks: [{ kind: "tool_result", toolUseId: "tub", content: "BASH_OUTPUT" }] },
    ],
  };

  test("default hides thinking/tools; toggles reveal them; Bash result pairs; Task shows subagent panel", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue(meta);
    vi.spyOn(api, "getTranscript").mockResolvedValue(transcript);
    vi.spyOn(api, "getSubagent").mockResolvedValue({ format: "claude", messages: [{ role: "assistant", blocks: [{ kind: "text", content: "SUBAGENT_TEXT" }] }] });

    renderView("s1");
    await screen.findByText("the answer");

    // default: no thinking, no tools
    expect(screen.queryByText("SECRET_REASONING")).not.toBeInTheDocument();
    expect(screen.queryByText("ls -la")).not.toBeInTheDocument();
    expect(screen.queryByText("Task")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Show thinking"));
    expect(screen.getByText("SECRET_REASONING")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Show tools"));
    expect(screen.getByText(/ls -la/)).toBeInTheDocument();      // Bash command
    expect(screen.getByText("BASH_OUTPUT")).toBeInTheDocument(); // paired result box
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText("Subagent")).toBeInTheDocument();    // subagent panel at the Task call

    fireEvent.click(screen.getByText("Subagent"));
    await waitFor(() => expect(screen.getByText("SUBAGENT_TEXT")).toBeInTheDocument());
  });
});
