// Ported from claude-session-viewer.
import { maskSecrets } from "./format";

export function containsXml(text: string): boolean {
  return /<[a-zA-Z][\w-]*(?:\s[^>]*)?>[\s\S]*?<\/[a-zA-Z][\w-]*>/.test(text);
}

function splitXmlSegments(text: string): Array<{ type: "text" | "xml"; content: string }> {
  const segments: Array<{ type: "text" | "xml"; content: string }> = [];
  const xmlPattern = /<([a-zA-Z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g;
  let lastIndex = 0;
  let match;
  while ((match = xmlPattern.exec(text)) !== null) {
    if (match.index > lastIndex) segments.push({ type: "text", content: text.slice(lastIndex, match.index) });
    segments.push({ type: "xml", content: match[0] });
    lastIndex = xmlPattern.lastIndex;
  }
  if (lastIndex < text.length) segments.push({ type: "text", content: text.slice(lastIndex) });
  return segments;
}

interface XmlNodeInfo { tag: string; attrs: string; children: Array<XmlNodeInfo | string> }

function parseXmlNodes(xml: string): Array<XmlNodeInfo | string> {
  const nodes: Array<XmlNodeInfo | string> = [];
  const tagPattern = /<([a-zA-Z][\w-]*)((?:\s+[^>]*)?)>([\s\S]*?)<\/\1>/g;
  let lastIndex = 0;
  let match;
  while ((match = tagPattern.exec(xml)) !== null) {
    if (match.index > lastIndex) {
      const text = xml.slice(lastIndex, match.index).trim();
      if (text) nodes.push(text);
    }
    nodes.push({ tag: match[1]!, attrs: match[2]!.trim(), children: parseXmlNodes(match[3]!) });
    lastIndex = tagPattern.lastIndex;
  }
  if (lastIndex < xml.length) {
    const text = xml.slice(lastIndex).trim();
    if (text) nodes.push(text);
  }
  return nodes;
}

function RenderXmlNode({ node }: { node: XmlNodeInfo | string; depth?: number }) {
  if (typeof node === "string") {
    const masked = maskSecrets(node);
    if (masked.length > 200) {
      return <div className="text-ink-light whitespace-pre-wrap break-words text-xs ml-4">{masked.slice(0, 500)}{masked.length > 500 ? "..." : ""}</div>;
    }
    return <span className="text-ink-light">{masked}</span>;
  }
  const hasOnlyText = node.children.length === 1 && typeof node.children[0] === "string" && (node.children[0] as string).length < 80;
  if (hasOnlyText) {
    return (
      <div className="flex gap-1 items-baseline">
        <span className="text-teal/70 font-medium">{node.tag}</span>
        <span className="text-ink-light">{maskSecrets(node.children[0] as string)}</span>
      </div>
    );
  }
  return (
    <div>
      <div className="text-teal/70 font-medium">
        {node.tag}{node.attrs && <span className="text-slate/50 font-normal ml-1">{node.attrs}</span>}
      </div>
      <div className="ml-3">{node.children.map((child, i) => <RenderXmlNode key={i} node={child} />)}</div>
    </div>
  );
}

export function XmlView({ text }: { text: string }) {
  const segments = splitXmlSegments(text);
  return (
    <div className="text-xs leading-relaxed space-y-1">
      {segments.map((seg, i) => {
        if (seg.type === "text") {
          const trimmed = seg.content.trim();
          if (!trimmed) return null;
          return <div key={i} className="text-ink whitespace-pre-wrap break-words">{maskSecrets(trimmed)}</div>;
        }
        const nodes = parseXmlNodes(seg.content);
        return <div key={i} className="bg-panel/40 rounded-lg px-3 py-2">{nodes.map((node, j) => <RenderXmlNode key={j} node={node} />)}</div>;
      })}
    </div>
  );
}
