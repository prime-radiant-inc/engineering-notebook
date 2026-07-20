// Ported from claude-session-viewer (app/components/session/ToolCallInline.tsx).
import { useState } from "react";
import { maskSecrets } from "./format";
import type { ContentBlock } from "./types";
import { DiffView } from "./DiffView";
import { SubagentPanel } from "./SubagentPanel";

interface ToolResult {
  content: string | ContentBlock[];
  isError: boolean;
}

interface SubagentContext {
  subagentMap: Record<string, string>;
  sessionId: string;
  onOpenSubagent?: (sessionId: string) => void;
}

interface ToolCallInlineProps {
  name: string;
  id: string;
  input: Record<string, unknown>;
  result?: ToolResult;
  subagentCtx?: SubagentContext;
}

function resultText(result: ToolResult): string {
  if (typeof result.content === "string") return result.content;
  return result.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function truncate(text: string, maxLines: number): [string, number] {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return [text, lines.length];
  return [lines.slice(0, maxLines).join("\n"), lines.length];
}

function ResultBox({ text, isError, maxLines = 25 }: { text: string; isError?: boolean; maxLines?: number }) {
  const [expanded, setExpanded] = useState(false);
  if (!text.trim()) return null;
  const masked = maskSecrets(text);
  const [truncated, totalLines] = truncate(masked, maxLines);
  const wasTruncated = totalLines > maxLines;
  const display = expanded ? masked : truncated;
  const remainingLines = totalLines - maxLines;

  return (
    <pre className={`text-xs whitespace-pre-wrap break-words mt-1 px-2.5 py-1.5 rounded-lg ${
      isError ? "bg-red-600/5 text-red-700" : "bg-panel/50 text-ink-light"
    }${expanded ? " max-h-[80vh] overflow-y-auto" : ""}`}>
      {display}
      {wasTruncated && !expanded && (
        <button onClick={() => setExpanded(true)} className="block text-teal hover:text-ink mt-1 cursor-pointer">
          show {remainingLines.toLocaleString()} more lines
        </button>
      )}
      {expanded && wasTruncated && (
        <button onClick={() => setExpanded(false)} className="block text-teal hover:text-ink mt-1 cursor-pointer">
          collapse
        </button>
      )}
    </pre>
  );
}

function Description({ text }: { text: string }) {
  if (!text) return null;
  return <div className="text-xs text-slate mb-0.5">{text}</div>;
}

function ToolLabel({ name }: { name: string }) {
  return <span className="text-xs font-medium text-ink-light">{name}</span>;
}

function BashCall({ input, result }: { input: Record<string, unknown>; result?: ToolResult }) {
  const description = String(input.description || "");
  const command = String(input.command || "");
  const output = result ? resultText(result) : "";
  return (
    <div>
      <Description text={description} />
      <div className="text-xs font-mono bg-panel/40 px-2.5 py-1.5 rounded-lg text-ink">
        <span className="text-slate select-none">$ </span>{maskSecrets(command)}
      </div>
      {result && <ResultBox text={output} isError={result.isError} maxLines={30} />}
    </div>
  );
}

function ReadCall({ input, result }: { input: Record<string, unknown>; result?: ToolResult }) {
  const filePath = String(input.file_path || "");
  const output = result ? resultText(result) : "";
  return (
    <div>
      <div className="text-xs"><ToolLabel name="Read" /> <span className="text-slate font-mono">{filePath}</span></div>
      {result && <ResultBox text={output} maxLines={20} />}
    </div>
  );
}

function WriteCall({ input, result }: { input: Record<string, unknown>; result?: ToolResult }) {
  const filePath = String(input.file_path || "");
  const output = result ? resultText(result) : "";
  return (
    <div>
      <div className="text-xs"><ToolLabel name="Write" /> <span className="text-slate font-mono">{filePath}</span></div>
      {result && output.trim() && <ResultBox text={output} isError={result.isError} maxLines={5} />}
    </div>
  );
}

function EditCall({ input, result }: { input: Record<string, unknown>; result?: ToolResult }) {
  const filePath = String(input.file_path || "");
  const hasStrings = typeof input.old_string === "string" && typeof input.new_string === "string";
  const output = result ? resultText(result) : "";
  return (
    <div>
      {hasStrings ? (
        <DiffView filePath={filePath} oldString={String(input.old_string)} newString={String(input.new_string)} />
      ) : (
        <div className="text-xs"><ToolLabel name="Edit" /> <span className="text-slate font-mono">{filePath}</span></div>
      )}
      {result && result.isError && <ResultBox text={output} isError maxLines={10} />}
    </div>
  );
}

function GlobCall({ input, result }: { input: Record<string, unknown>; result?: ToolResult }) {
  const pattern = String(input.pattern || "");
  const path = input.path ? String(input.path) : "";
  const output = result ? resultText(result) : "";
  return (
    <div>
      <div className="text-xs">
        <ToolLabel name="Glob" /> <span className="text-slate font-mono">{pattern}</span>
        {path && <span className="text-slate/60 font-mono ml-1">in {path}</span>}
      </div>
      {result && <ResultBox text={output} maxLines={20} />}
    </div>
  );
}

function GrepCall({ input, result }: { input: Record<string, unknown>; result?: ToolResult }) {
  const pattern = String(input.pattern || "");
  const path = input.path ? String(input.path) : "";
  const glob = input.glob ? String(input.glob) : "";
  const output = result ? resultText(result) : "";
  return (
    <div>
      <div className="text-xs">
        <ToolLabel name="Grep" /> <span className="text-slate font-mono">{pattern}</span>
        {glob && <span className="text-slate/60 font-mono ml-1">({glob})</span>}
        {path && <span className="text-slate/60 font-mono ml-1">in {path}</span>}
      </div>
      {result && <ResultBox text={output} maxLines={25} />}
    </div>
  );
}

function TaskCall({ name, input, id, subagentCtx }: { name: string; input: Record<string, unknown>; result?: ToolResult; id: string; subagentCtx?: SubagentContext }) {
  const description = String(input.description || "");
  const subagentType = String(input.subagent_type || "");
  const agentId = subagentCtx?.subagentMap[id];
  const openSubagent = subagentCtx?.onOpenSubagent;
  return (
    <div>
      <div className="text-xs">
        <ToolLabel name={name} />{" "}
        {subagentType && <span className="text-teal font-medium">[{subagentType}]</span>}{" "}
        <span className="text-slate">{description}</span>
        {agentId && openSubagent && (
          <button
            onClick={() => openSubagent(`agent-${agentId}`)}
            className="text-teal underline hover:text-ink ml-1.5 whitespace-nowrap"
            title="Open this subagent's transcript in panel 3"
          >
            ↗ open subagent
          </button>
        )}
      </div>
      {agentId && subagentCtx && (
        <SubagentPanel sessionId={subagentCtx.sessionId} agentId={agentId} description={description} agentType={subagentType} />
      )}
    </div>
  );
}

function TaskManagementCall({ name, input, result }: { name: string; input: Record<string, unknown>; result?: ToolResult }) {
  const output = result ? resultText(result) : "";
  if (name === "TaskCreate" || name === "TodoWrite") {
    const subject = String(input.subject || input.title || "");
    const description = String(input.description || "");
    return (
      <div className="text-xs">
        <ToolLabel name={name} /> {subject && <span className="text-ink font-medium">{subject}</span>}
        {description && <div className="text-slate mt-0.5 ml-4">{description.slice(0, 200)}{description.length > 200 ? "..." : ""}</div>}
        {result && result.isError && <ResultBox text={output} isError maxLines={5} />}
      </div>
    );
  }
  if (name === "TaskUpdate") {
    const taskId = String(input.taskId || "");
    const status = input.status ? String(input.status) : "";
    return (
      <div className="text-xs">
        <ToolLabel name="TaskUpdate" /> <span className="text-slate">#{taskId}</span>
        {status && <span className="text-ink ml-1">{status}</span>}
        {result && result.isError && <ResultBox text={output} isError maxLines={5} />}
      </div>
    );
  }
  return (
    <div className="text-xs">
      <ToolLabel name={name} />
      {result && <ResultBox text={output} maxLines={15} />}
    </div>
  );
}

function WebCall({ name, input, result }: { name: string; input: Record<string, unknown>; result?: ToolResult }) {
  const url = String(input.url || input.query || "");
  const output = result ? resultText(result) : "";
  return (
    <div>
      <div className="text-xs"><ToolLabel name={name} /> <span className="text-slate font-mono break-all">{maskSecrets(url)}</span></div>
      {result && <ResultBox text={output} maxLines={20} />}
    </div>
  );
}

function DefaultCall({ name, input, result }: { name: string; input: Record<string, unknown>; result?: ToolResult }) {
  const description = String(input.description || "");
  const output = result ? resultText(result) : "";
  const keys = Object.keys(input).filter((k) => k !== "description");
  const isSimple = keys.length <= 2 && keys.every((k) => typeof input[k] === "string" && String(input[k]).length < 100);
  return (
    <div>
      {description && <Description text={description} />}
      <div className="text-xs">
        <ToolLabel name={name} />
        {isSimple && keys.map((k) => (
          <span key={k} className="text-slate ml-1.5"><span className="text-slate/60">{k}:</span> {maskSecrets(String(input[k]))}</span>
        ))}
      </div>
      {!isSimple && keys.length > 0 && (
        <details className="mt-1 group">
          <summary className="text-xs text-slate/60 cursor-pointer hover:text-ink select-none">parameters</summary>
          <pre className="text-xs whitespace-pre-wrap break-words mt-1 px-2.5 py-1.5 bg-panel/50 rounded-lg text-ink-light">
            {maskSecrets(JSON.stringify(input, null, 2).slice(0, 1000))}
          </pre>
        </details>
      )}
      {result && <ResultBox text={output} isError={result.isError} maxLines={20} />}
    </div>
  );
}

const TASK_TOOLS = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite", "TodoRead"]);
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

export function ToolCallInline({ name, id, input, result, subagentCtx }: ToolCallInlineProps) {
  let content: React.ReactNode;
  // A subagent spawn is identified by the block id being in the subagent map,
  // not by the tool name (Claude Code names it "Agent", others use "Task").
  const isSpawn = !!subagentCtx?.subagentMap[id];
  if (isSpawn) content = <TaskCall name={name} input={input} result={result} id={id} subagentCtx={subagentCtx} />;
  else if (name === "Bash") content = <BashCall input={input} result={result} />;
  else if (name === "Read") content = <ReadCall input={input} result={result} />;
  else if (name === "Write") content = <WriteCall input={input} result={result} />;
  else if (name === "Edit") content = <EditCall input={input} result={result} />;
  else if (name === "Glob") content = <GlobCall input={input} result={result} />;
  else if (name === "Grep") content = <GrepCall input={input} result={result} />;
  else if (name === "Task") content = <TaskCall name={name} input={input} result={result} id={id} subagentCtx={subagentCtx} />;
  else if (TASK_TOOLS.has(name)) content = <TaskManagementCall name={name} input={input} result={result} />;
  else if (WEB_TOOLS.has(name)) content = <WebCall name={name} input={input} result={result} />;
  else content = <DefaultCall name={name} input={input} result={result} />;
  return <div className="my-1">{content}</div>;
}
