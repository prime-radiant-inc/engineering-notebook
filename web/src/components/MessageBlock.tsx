import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

export function MessageText({ role, content }: { role: "user" | "assistant"; content: string }) {
  return (
    <div className="my-3">
      <div className="text-[11px] text-stone-400 mb-0.5">{role === "user" ? "User" : "Assistant"}</div>
      <div className="prose prose-sm max-w-none prose-stone">
        <Markdown remarkPlugins={[remarkGfm]}>{content}</Markdown>
      </div>
    </div>
  );
}
