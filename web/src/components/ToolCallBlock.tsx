import { toolPreview } from "../toolPreview";

export function ToolCallBlock({
  name,
  input,
  body,
  result,
}: {
  name?: string;
  input?: Record<string, unknown>;
  body: string;
  result?: string;
}) {
  const preview = toolPreview(name, input);
  return (
    <details className="border border-stone-200 rounded-lg px-3 py-1.5 my-2 text-xs">
      <summary className="cursor-pointer list-none text-stone-500 select-none">
        <span className="text-accent font-semibold">{name || "tool"}</span>
        {preview && <span className="ml-2 text-stone-400 font-mono">{preview}</span>}
      </summary>
      <pre className="whitespace-pre-wrap font-mono text-[11px] mt-1.5 mb-0">{body}</pre>
      {result != null && (
        <div className="border-t border-stone-100 mt-1.5 pt-1.5">
          <div className="text-stone-400">&#8627; result</div>
          <pre className="whitespace-pre-wrap font-mono text-[11px] mt-1 mb-0">{result}</pre>
        </div>
      )}
    </details>
  );
}
