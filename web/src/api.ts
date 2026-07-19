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
};

export type Subagent = {
  agentId: string;
  agentType?: string;
  description?: string;
  toolUseId?: string;
  spawnDepth?: number;
};

export type SessionListRow = {
  id: string;
  project_id: string;
  display_name: string;
  started_at: string;
  ended_at: string | null;
  message_count: number;
  is_subagent: number;
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

export function getTranscript(id: string): Promise<Transcript> {
  return getJson<Transcript>(`/api/sessions/${encodeURIComponent(id)}/transcript`);
}

export function getSubagent(sessionId: string, agentId: string): Promise<Transcript> {
  return getJson<Transcript>(`/api/subagent/${encodeURIComponent(sessionId)}/${encodeURIComponent(agentId)}`);
}

export type JournalDate = { date: string; projects: string[] };
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
};

export function getJournalDates(): Promise<{ dates: JournalDate[] }> {
  return getJson<{ dates: JournalDate[] }>("/api/journal/dates");
}

export function getJournalEntries(date: string): Promise<{ entries: JournalEntry[] }> {
  return getJson<{ entries: JournalEntry[] }>(`/api/journal/entries?date=${encodeURIComponent(date)}`);
}
