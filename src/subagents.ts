import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve, sep } from "path";

export type Subagent = { agentId:string; agentType?:string; description?:string; toolUseId?:string; spawnDepth?:number };

export function subagentDir(projectDir: string, sessionId: string): string {
  return join(projectDir, sessionId, "subagents");
}

/**
 * Builds the on-disk path for a subagent's transcript, then asserts the resolved
 * path is still contained within the subagent directory. This is a defense-in-depth
 * check: callers should also validate agentId's shape before reaching here, but this
 * guards against any future caller that forgets to.
 */
export function subagentFilePath(projectDir: string, sessionId: string, agentId: string): string | null {
  const dir = subagentDir(projectDir, sessionId);
  const candidate = resolve(join(dir, `agent-${agentId}.jsonl`));
  const containingDir = resolve(dir) + sep;
  if (!candidate.startsWith(containingDir)) return null;
  return candidate;
}

export function discoverSubagents(projectDir: string, sessionId: string): Subagent[] {
  const dir = subagentDir(projectDir, sessionId);
  if (!existsSync(dir)) return [];
  const out: Subagent[] = [];
  for (const name of readdirSync(dir)) {
    const m = /^agent-(.+)\.jsonl$/.exec(name);
    if (!m) continue;
    const agentId = m[1]!;
    let meta: Partial<Subagent> = {};
    const metaPath = join(dir, `agent-${agentId}.meta.json`);
    if (existsSync(metaPath)) {
      try {
        const j = JSON.parse(readFileSync(metaPath, "utf-8"));
        meta = { agentType: j.agentType, description: j.description, toolUseId: j.toolUseId, spawnDepth: j.spawnDepth };
      } catch { /* ignore malformed meta */ }
    }
    out.push({ agentId, ...meta });
  }
  out.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return out;
}
