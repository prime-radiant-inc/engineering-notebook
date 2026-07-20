// Typed client for the engineering-notebook JSON API (Phase 1).

export type StructuredBlock = {
  kind: "text" | "thinking" | "tool_use" | "tool_result";
  content: string;
  name?: string;
  id?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  isError?: boolean;
};

export type StructuredMessage = {
  role: "user" | "assistant";
  uuid?: string;
  parentUuid?: string | null;
  timestamp?: string;
  model?: string;
  isMeta?: boolean;
  blocks: StructuredBlock[];
};

export type Transcript = {
  messages: StructuredMessage[];
  format: "claude" | "codex" | "unknown";
  compacted?: boolean;
};

export type Subagent = {
  agentId: string;
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
  started_at?: string | null;
};

export type SessionListRow = {
  id: string;
  project_id: string;
  display_name: string;
  started_at: string;
  ended_at: string | null;
  message_count: number;
  is_subagent: number;
  title: string | null;
};

export type SessionListResponse = { sessions: SessionListRow[]; total: number };

export type SessionMeta = {
  id: string;
  project_id: string;
  project_path: string;
  source_path: string;
  started_at: string;
  ended_at: string | null;
  message_count: number;
  git_branch: string | null;
  title: string | null;
  title_source: "desktop" | "user" | "generated" | null;
  is_subagent?: number;
  parent_session_id: string | null;
  parent_title: string | null;
  subtask_title?: string | null;
  spawn_tool_use_id?: string | null;
  subagents: Subagent[];
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    let msg = `${res.status}`;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      /* non-JSON error */
    }
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

export function getSessions(params: { limit?: number; offset?: number; project?: string } = {}): Promise<SessionListResponse> {
  const q = new URLSearchParams();
  if (params.limit != null) q.set("limit", String(params.limit));
  if (params.offset != null) q.set("offset", String(params.offset));
  if (params.project) q.set("project", params.project);
  const qs = q.toString();
  return getJson<SessionListResponse>(`/api/sessions${qs ? `?${qs}` : ""}`);
}

export function getSession(id: string): Promise<SessionMeta> {
  return getJson<SessionMeta>(`/api/sessions/${encodeURIComponent(id)}`);
}

export function getTranscript(id: string, full = false): Promise<Transcript> {
  const q = full ? "?full=1" : "";
  return getJson<Transcript>(`/api/sessions/${encodeURIComponent(id)}/transcript${q}`);
}

export function getSubagent(sessionId: string, agentId: string): Promise<Transcript> {
  return getJson<Transcript>(`/api/subagent/${encodeURIComponent(sessionId)}/${encodeURIComponent(agentId)}`);
}

export type JournalDate = { date: string; projects: string[] };
export type SubagentRef = { id: string; agentType?: string; description?: string };
export type SessionRef = { id: string; title: string | null; subagents: SubagentRef[] };
export type JournalEntry = {
  id: number;
  date: string;
  project_id: string;
  display_name: string;
  headline: string;
  summary: string;
  topics: string[];
  open_questions: string[];
  session_ids: string[];
  sessions: SessionRef[];
};

export function getJournalDates(): Promise<{ dates: JournalDate[] }> {
  return getJson<{ dates: JournalDate[] }>("/api/journal/dates");
}

export function getJournalEntries(date: string): Promise<{ entries: JournalEntry[] }> {
  return getJson<{ entries: JournalEntry[] }>(`/api/journal/entries?date=${encodeURIComponent(date)}`);
}

export type ProjectRow = { id: string; display_name: string; last_session_at: string | null; session_count: number };
export function getProjects(): Promise<{ projects: ProjectRow[] }> {
  return getJson("/api/projects");
}
export function getProjectEntries(id: string): Promise<{ entries: JournalEntry[] }> {
  return getJson(`/api/projects/${encodeURIComponent(id)}/entries`);
}

export type CalendarDay = { date: string; entries: number; projects: string[] };
export function getCalendar(month: string): Promise<{ days: CalendarDay[] }> {
  return getJson(`/api/calendar?month=${encodeURIComponent(month)}`);
}

export type GroupRow = { id: number; name: string; sessionCount: number; lastActivityAt: string | null };
export type GroupSessionRow = { id: string; display_name: string; project_id: string; started_at: string; message_count: number; title: string | null; subagents?: SubagentRef[] };
export function getGroups(): Promise<{ groups: GroupRow[]; desktopRunning: boolean }> {
  return getJson("/api/groups");
}
export function getGroup(id: number): Promise<{ group: { id: number; name: string }; sessions: GroupSessionRow[] }> {
  return getJson(`/api/groups/${id}`);
}
export function getUngrouped(): Promise<{ sessions: GroupSessionRow[]; total: number }> {
  return getJson("/api/groups/ungrouped");
}
export async function importDesktopGroups(): Promise<{ imported: boolean; summary?: Record<string, number>; message?: string; error?: string }> {
  const res = await fetch("/api/groups/import-desktop", { method: "POST" });
  return res.json();
}
