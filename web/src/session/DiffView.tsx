// Ported from claude-session-viewer.
import { maskSecrets } from "./format";

export function DiffView({ filePath, oldString, newString }: { filePath: string; oldString: string; newString: string }) {
  const oldLines = maskSecrets(oldString).split("\n");
  const newLines = maskSecrets(newString).split("\n");
  return (
    <div className="text-xs leading-relaxed">
      <div className="text-slate font-medium mb-1">{filePath}</div>
      <div className="rounded-lg overflow-hidden border border-edge/50">
        {oldLines.map((line, i) => (
          <div key={`old-${i}`} className="bg-red-600/5 px-2 py-0.5 flex gap-2">
            <span className="text-red-600/60 select-none shrink-0">&minus;</span>
            <span className="text-red-600/80 whitespace-pre-wrap break-words min-w-0">{line}</span>
          </div>
        ))}
        {newLines.map((line, i) => (
          <div key={`new-${i}`} className="bg-teal/5 px-2 py-0.5 flex gap-2">
            <span className="text-teal/60 select-none shrink-0">+</span>
            <span className="text-teal/80 whitespace-pre-wrap break-words min-w-0">{line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
