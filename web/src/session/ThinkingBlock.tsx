// Ported from claude-session-viewer.
export function ThinkingBlock({ content }: { content: string }) {
  const redacted = !content.trim();
  return (
    <div className="text-xs text-slate italic bg-panel/60 px-4 py-3 rounded-2xl rounded-tl-sm whitespace-pre-wrap break-words">
      {redacted ? (
        <span className="not-italic text-slate/60">&#128274; redacted thinking</span>
      ) : (
        <>
          {content}
          {content.length > 100 && (
            <span className="block text-right text-slate/40 text-[10px] mt-2 not-italic">
              ~{Math.round(content.length / 4).toLocaleString()} tokens
            </span>
          )}
        </>
      )}
    </div>
  );
}
