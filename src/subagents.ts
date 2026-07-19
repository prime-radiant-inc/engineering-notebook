import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";

export type Subagent = { agentId:string; agentType?:string; description?:string; toolUseId?:string; spawnDepth?:number };

export function subagentDir(projectDir: string, sessionId: string): string {
  return join(projectDir, sessionId, "subagents");
}
export function subagentFilePath(projectDir: string, sessionId: string, agentId: string): string {
  return join(subagentDir(projectDir, sessionId), `agent-${agentId}.jsonl`);
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
