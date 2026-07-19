import type { StructuredMessage } from "./transcript-structured";

type Node = { msg: StructuredMessage; children: Node[] };

/**
 * Reconstruct the conversation tree from uuid/parentUuid and return the active
 * branch. Ported from claude-session-viewer's buildMessageTree +
 * resolveActivePath (app/lib/tree.ts): at each fork, follow the child whose
 * subtree has the latest timestamp.
 *
 * `allParent` maps EVERY record's uuid -> parentUuid (including filtered
 * meta/summary/progress records) so parent chains can bridge through them.
 * Falls back to the given order when there is no usable tree (e.g. Codex,
 * or older logs without uuids).
 */
export function resolveActivePath(
  messages: StructuredMessage[],
  allParent: Map<string, string | null>,
): StructuredMessage[] {
  const nodesByUuid = new Map<string, Node>();
  for (const m of messages) if (m.uuid) nodesByUuid.set(m.uuid, { msg: m, children: [] });
  if (nodesByUuid.size === 0) return messages;

  const roots: Node[] = [];
  for (const node of nodesByUuid.values()) {
    let p: string | null | undefined = node.msg.parentUuid ?? null;
    let found = false;
    const seen = new Set<string>();
    while (p && !seen.has(p)) {
      seen.add(p);
      const pn = nodesByUuid.get(p);
      if (pn) { pn.children.push(node); found = true; break; }
      p = allParent.get(p) ?? null; // bridge through filtered records
    }
    if (!found) roots.push(node);
  }
  if (roots.length === 0) return messages;

  const memo = new Map<Node, string>();
  const deepest = (n: Node): string => {
    const cached = memo.get(n);
    if (cached !== undefined) return cached;
    let latest = n.msg.timestamp ?? "";
    for (const ch of n.children) {
      const t = deepest(ch);
      if (t > latest) latest = t;
    }
    memo.set(n, latest);
    return latest;
  };

  let current = roots.reduce((best, r) => (deepest(r) > deepest(best) ? r : best));
  const path: StructuredMessage[] = [current.msg];
  while (current.children.length > 0) {
    current = current.children.reduce((best, ch) => (deepest(ch) > deepest(best) ? ch : best));
    path.push(current.msg);
  }
  return path;
}
