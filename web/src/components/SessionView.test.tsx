import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionView } from "./SessionView";
import * as api from "../api";

describe("SessionView", () => {
  beforeEach(() => vi.restoreAllMocks());

  const meta: api.SessionMeta = {
    id: "s1", project_id: "proj", project_path: "/p", source_path: "/p/s1.jsonl",
    started_at: "2026-07-10T00:00:00Z", ended_at: null, message_count: 2,
    subagents: [{ agentId: "ag1", description: "do a thing", agentType: "general-purpose", toolUseId: "tu1", spawnDepth: 1 }],
  };
  const transcript: api.Transcript = {
    format: "claude",
    messages: [
      { role: "assistant", blocks: [
        { kind: "thinking", content: "SECRET_REASONING" },
        { kind: "text", content: "the answer" },
        { kind: "tool_use", id: "tu1", name: "Task", input: { description: "do a thing" }, content: "{}" },
      ] },
      { role: "user", blocks: [{ kind: "tool_result", toolUseId: "tu1", content: "TOOL_OUTPUT" }] },
    ],
  };

  test("default hides thinking/tools; toggles reveal them; subagent panel lazy-loads", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue(meta);
    vi.spyOn(api, "getTranscript").mockResolvedValue(transcript);
    vi.spyOn(api, "getSubagent").mockResolvedValue({ format: "claude", messages: [{ role: "assistant", blocks: [{ kind: "text", content: "SUBAGENT_TEXT" }] }] });

    render(<SessionView id="s1" />);
    await screen.findByText("the answer");
    expect(screen.queryByText("SECRET_REASONING")).not.toBeInTheDocument();
    expect(screen.queryByText("Task")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Show thinking"));
    expect(screen.getByText("SECRET_REASONING")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Show tools"));
    expect(screen.getByText("Task")).toBeInTheDocument();
    expect(screen.getByText(/TOOL_OUTPUT/)).toBeInTheDocument();
    expect(screen.getByText("Subagent")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Subagent"));
    await waitFor(() => expect(screen.getByText("SUBAGENT_TEXT")).toBeInTheDocument());
  });

  test("shows empty-state note when a shown kind is absent", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue({ ...meta, subagents: [] });
    vi.spyOn(api, "getTranscript").mockResolvedValue({ format: "claude", messages: [{ role: "assistant", blocks: [{ kind: "text", content: "just text" }] }] });
    render(<SessionView id="s1" />);
    await screen.findByText("just text");
    fireEvent.click(screen.getByText("Show thinking"));
    expect(screen.getByText("No thinking data for this session.")).toBeInTheDocument();
  });
});
