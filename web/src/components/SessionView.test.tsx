import { describe, test, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SessionView } from "./SessionView";
import { TranscriptTogglesProvider, TranscriptToggleButtons } from "../session/toggleContext";
import * as api from "../api";

function renderView(id: string, onOpenSession?: (id: string) => void) {
  return render(
    <TranscriptTogglesProvider>
      <TranscriptToggleButtons />
      <SessionView id={id} onOpenSession={onOpenSession} />
    </TranscriptTogglesProvider>,
  );
}

describe("SessionView (ported viewer)", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // jsdom has no scrollIntoView; stub it so focus-scroll paths can run/assert.
    Element.prototype.scrollIntoView = vi.fn();
  });

  const meta: api.SessionMeta = {
    id: "s1", project_id: "proj", project_path: "/p", source_path: "/p/s1.jsonl",
    started_at: "2026-07-10T00:00:00Z", ended_at: null, message_count: 3, git_branch: null, title: null, title_source: null,
    parent_session_id: null, parent_title: null,
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
    // Subagent panel at the Task call is labelled by its subtask title (description),
    // with no agent-type prefix.
    const subToggle = screen.getByRole("button", { name: /do a thing/ });
    expect(subToggle).toBeInTheDocument();
    expect(subToggle.textContent).not.toMatch(/general-purpose/);

    fireEvent.click(subToggle);
    await waitFor(() => expect(screen.getByText("SUBAGENT_TEXT")).toBeInTheDocument());
  });

  test("renders an 'open subagent' link at the Task invocation that navigates to the subagent session", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue(meta);
    vi.spyOn(api, "getTranscript").mockResolvedValue(transcript);
    const onOpen = vi.fn();

    renderView("s1", onOpen);
    await screen.findByText("the answer");
    fireEvent.click(screen.getByText("Show tools"));

    const link = screen.getByRole("button", { name: /open subagent/i });
    fireEvent.click(link);
    // Navigates to the subagent's own session id (agent-<agentId>).
    expect(onOpen).toHaveBeenCalledWith("agent-ag1");
  });

  test("defaults to the uncompacted (full) transcript; the toggle switches to compacted and back", async () => {
    const getT = vi.spyOn(api, "getTranscript").mockResolvedValue({ ...transcript, compacted: true });
    vi.spyOn(api, "getSession").mockResolvedValue(meta);

    renderView("s1", vi.fn());
    await screen.findByText("the answer");
    // Default is uncompacted → full transcript requested.
    expect(getT).toHaveBeenLastCalledWith("s1", true);

    // Enabled because the session is compacted.
    const toggle = screen.getByRole("button", { name: "View compacted" });
    expect(toggle).not.toBeDisabled();
    fireEvent.click(toggle);
    await waitFor(() => expect(getT).toHaveBeenLastCalledWith("s1", false));
    // Button label flips to offer switching back.
    expect(screen.getByRole("button", { name: "View uncompacted" })).toBeInTheDocument();
  });

  test("the compacted toggle is disabled when the session was not compacted", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue(meta);
    vi.spyOn(api, "getTranscript").mockResolvedValue(transcript); // no `compacted` → false

    renderView("s1", vi.fn());
    await screen.findByText("the answer");
    expect(screen.getByRole("button", { name: "View compacted" })).toBeDisabled();
  });

  test("subagent spawn link is visible even with tools hidden, and it navigates", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue(meta);
    vi.spyOn(api, "getTranscript").mockResolvedValue(transcript);
    const onOpen = vi.fn();

    renderView("s1", onOpen);
    await screen.findByText("the answer");

    // Tools are hidden by default: tool output is NOT shown...
    expect(screen.queryByText(/ls -la/)).not.toBeInTheDocument();
    // ...but the subagent spawn point is still linked.
    const link = screen.getByRole("button", { name: /do a thing/i });
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("agent-ag1");
  });

  test("links a subagent spawned via the 'Agent' tool (not just 'Task'), matched by tool id", async () => {
    const agentMeta: api.SessionMeta = {
      ...meta,
      subagents: [{ agentId: "ag9", description: "explore the schema", agentType: "Explore", toolUseId: "tuAgent", spawnDepth: 1 }],
    };
    const agentTranscript: api.Transcript = {
      format: "claude",
      messages: [
        { role: "assistant", blocks: [
          { kind: "text", content: "spawning" },
          { kind: "tool_use", id: "tuAgent", name: "Agent", input: { description: "explore the schema", subagent_type: "Explore" }, content: "{}" },
        ] },
      ],
    };
    vi.spyOn(api, "getSession").mockResolvedValue(agentMeta);
    vi.spyOn(api, "getTranscript").mockResolvedValue(agentTranscript);
    const onOpen = vi.fn();

    renderView("s1", onOpen);
    await screen.findByText("spawning");
    // Tools hidden by default — the Agent spawn still links.
    const link = screen.getByRole("button", { name: /explore the schema/i });
    fireEvent.click(link);
    expect(onOpen).toHaveBeenCalledWith("agent-ag9");
  });

  test("lists all subagents in a compaction-proof index even with no spawn block on the transcript", async () => {
    const compactMeta: api.SessionMeta = {
      ...meta,
      subagents: [
        { agentId: "c1", description: "early exploration", agentType: "Explore", toolUseId: "x1", spawnDepth: 1, started_at: "2026-07-10T01:00:00Z" },
        { agentId: "c2", description: "first-round review", agentType: "general-purpose", toolUseId: "x2", spawnDepth: 1, started_at: "2026-07-10T02:00:00Z" },
      ],
    };
    // Transcript with NO Task/Agent tool_use — the spawn points were compacted away.
    const noSpawn: api.Transcript = { format: "claude", messages: [{ role: "assistant", blocks: [{ kind: "text", content: "compacted summary" }] }] };
    vi.spyOn(api, "getSession").mockResolvedValue(compactMeta);
    vi.spyOn(api, "getTranscript").mockResolvedValue(noSpawn);
    const onOpen = vi.fn();

    renderView("s1", onOpen);
    await screen.findByText("compacted summary");

    // Index present; collapsed by default (titles hidden until expanded).
    const toggle = screen.getByRole("button", { name: /2 subagents/ });
    expect(screen.queryByText("early exploration")).not.toBeInTheDocument();

    fireEvent.click(toggle);
    fireEvent.click(screen.getByText("first-round review"));
    expect(onOpen).toHaveBeenCalledWith("agent-c2");
  });

  test("backlink navigates to the parent carrying the spawn tool_use id", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue({
      ...meta, id: "agent-z1", is_subagent: 1, parent_session_id: "parentX", parent_title: "Parent",
      subtask_title: "explore", spawn_tool_use_id: "tu1", subagents: [],
    });
    vi.spyOn(api, "getTranscript").mockResolvedValue({ format: "claude", messages: [{ role: "user", blocks: [{ kind: "text", content: "sub body" }] }] });
    const onOpen = vi.fn();

    renderView("agent-z1", onOpen);
    const back = await screen.findByRole("button", { name: /Subagent of/ });
    fireEvent.click(back);
    expect(onOpen).toHaveBeenCalledWith("parentX", "tu1");
  });

  test("focusing a spawn tool id scrolls the correct spawn element exactly once", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue(meta);
    vi.spyOn(api, "getTranscript").mockResolvedValue(transcript);

    render(
      <TranscriptTogglesProvider>
        <SessionView id="s1" onOpenSession={() => {}} focusToolUseId="tu1" />
      </TranscriptTogglesProvider>,
    );
    await screen.findByText("the answer");
    expect(document.getElementById("spawn-tu1")).toBeTruthy();
    // Scrolls the anchored spawn element (not some other node)…
    await waitFor(() => expect((Element.prototype.scrollIntoView as any).mock.contexts.length).toBeGreaterThan(0));
    const scroll = Element.prototype.scrollIntoView as any;
    expect(scroll.mock.contexts.every((el: Element) => el.id === "spawn-tu1")).toBe(true);
    // …and only once (the ref guard prevents re-scrolling on batch growth).
    expect(scroll.mock.calls.length).toBe(1);
  });

  test("a continuation (non-subagent with a parent_session_id) shows NO 'Subagent of' backlink", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue({
      ...meta, id: "resumed", title: "Resumed Session", is_subagent: 0, parent_session_id: "orig", parent_title: null, subagents: [],
    });
    vi.spyOn(api, "getTranscript").mockResolvedValue({ format: "claude", messages: [{ role: "user", blocks: [{ kind: "text", content: "resumed body" }] }] });

    renderView("resumed", vi.fn());
    await screen.findByText("resumed body");
    expect(screen.queryByText(/Subagent of/)).not.toBeInTheDocument();
  });

  test("without onOpenSession, the subagent index and spawn links are not shown", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue(meta); // meta has 1 subagent
    vi.spyOn(api, "getTranscript").mockResolvedValue(transcript);

    // renderView passes no onOpenSession (tools hidden by default).
    renderView("s1");
    await screen.findByText("the answer");
    // No index (gated on onOpenSession) and no navigable spawn link (gated on the handler).
    expect(screen.queryByRole("button", { name: /subagent/i })).not.toBeInTheDocument();
    expect(screen.queryByText("do a thing")).not.toBeInTheDocument();
  });

  test("when the spawn is compacted off the transcript, the index opens and highlights the entry", async () => {
    const compactMeta: api.SessionMeta = {
      ...meta,
      subagents: [{ agentId: "c2", description: "first-round review", agentType: "general-purpose", toolUseId: "x2", spawnDepth: 1, started_at: "t" }],
    };
    const noSpawn: api.Transcript = { format: "claude", messages: [{ role: "assistant", blocks: [{ kind: "text", content: "compacted summary" }] }] };
    vi.spyOn(api, "getSession").mockResolvedValue(compactMeta);
    vi.spyOn(api, "getTranscript").mockResolvedValue(noSpawn);

    render(
      <TranscriptTogglesProvider>
        <SessionView id="s1" onOpenSession={() => {}} focusToolUseId="x2" />
      </TranscriptTogglesProvider>,
    );
    await screen.findByText("compacted summary");
    // Index auto-opened and the compacted subagent is shown + scrolled to.
    expect(await screen.findByText("first-round review")).toBeInTheDocument();
    await waitFor(() => expect(Element.prototype.scrollIntoView).toHaveBeenCalled());
  });

  test("a subagent view titles the panel with its subtask_title, not the first prompt", async () => {
    vi.spyOn(api, "getSession").mockResolvedValue({
      id: "agent-z1", project_id: "proj", project_path: "/p", source_path: "/p/x/subagents/agent-z1.jsonl",
      started_at: "t", ended_at: null, message_count: 1, git_branch: null, title: null, title_source: null,
      is_subagent: 1, parent_session_id: "parentX", parent_title: "Parent", subtask_title: "Verify sessions table schema", subagents: [],
    });
    vi.spyOn(api, "getTranscript").mockResolvedValue({
      format: "claude",
      messages: [{ role: "user", blocks: [{ kind: "text", content: "You are a subagent. Investigate the schema in great detail…" }] }],
    });

    renderView("agent-z1");
    const heading = await screen.findByRole("heading", { level: 1 });
    expect(heading).toHaveTextContent("Verify sessions table schema");
    expect(heading).not.toHaveTextContent(/great detail/);
  });
});
