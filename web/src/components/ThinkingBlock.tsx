export function ThinkingBlock({ content }: { content: string }) {
  return (
    <div className="text-xs text-stone-500 italic bg-stone-100 px-3.5 py-3 rounded-2xl rounded-tl-sm whitespace-pre-wrap break-words my-2">
      {content}
      {content.length > 100 && (
        <span className="block text-right text-stone-400 text-[10px] mt-2 not-italic">
          ~{Math.round(content.length / 4).toLocaleString()} tokens
        </span>
      )}
    </div>
  );
}
