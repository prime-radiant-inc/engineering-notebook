// One-line preview for a tool call, shown in the collapsed <summary>.
export function toolPreview(name: string | undefined, input: Record<string, unknown> | undefined): string {
  if (!name || !input) return "";
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
      return s(input.file_path);
    case "Bash":
      return s(input.command).slice(0, 80);
    case "Glob":
    case "Grep":
      return s(input.pattern);
    case "Task":
      return s(input.description);
    case "WebFetch":
      return s(input.url);
    default:
      return "";
  }
}
