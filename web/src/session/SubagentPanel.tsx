// Ported from claude-session-viewer (fetches this app's /api/subagent).
import { useState } from "react";
import { getSubagent } from "../api";
import type { ParsedMessage } from "./types";
import { toParsedMessages } from "./adapt";
import { MessageList } from "./MessageList";

export function SubagentPanel({ sessionId, agentId, description }: { sessionId: string; agentId: string; description?: string }) {
  const [expanded, setExpanded] = useState(false);
  const [messages, setMessages] = useState<ParsedMessage[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle() {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (messages) return;
    setLoading(true);
    try {
      const data = await getSubagent(sessionId, agentId);
      setMessages(toParsedMessages(data.messages));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="my-2 ml-4 bg-teal-wash/30 rounded-lg px-3 py-2">
      <button onClick={handleToggle} className="text-xs text-teal hover:text-ink cursor-pointer select-none flex items-center gap-1">
        <span className={`inline-block transition-transform ${expanded ? "rotate-90" : ""}`}>&#9654;</span>
        <span className="font-medium">Subagent</span>
        {description && <span className="text-slate ml-1">{description}</span>}
      </button>
      {expanded && (
        <div className="mt-2">
          {loading && <p className="text-xs text-slate">Loading subagent conversation…</p>}
          {error && <p className="text-xs text-red-600">{error}</p>}
          {messages && (
            <MessageList messages={messages} sessionId={sessionId} showThinking={true} showTools={true} userName="Agent" assistantLabel="Subagent" />
          )}
        </div>
      )}
    </div>
  );
}
