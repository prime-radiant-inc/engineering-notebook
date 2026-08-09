// Ported from claude-session-viewer (app/lib/format.ts).
const SECRET_PATTERNS: Array<{ pattern: RegExp; prefixLen: number }> = [
  { pattern: /sk-ant-\S+/g, prefixLen: 6 },
  { pattern: /sk-[A-Za-z0-9\-]{20,}/g, prefixLen: 6 },
  { pattern: /AKIA[A-Z0-9]{16}/g, prefixLen: 6 },
  { pattern: /Bearer\s+[A-Za-z0-9._\-]{10,}/g, prefixLen: 13 },
  { pattern: /xox[bpras]-[A-Za-z0-9\-]+/g, prefixLen: 6 },
  { pattern: /ghp_[A-Za-z0-9]{36}/g, prefixLen: 6 },
  { pattern: /gho_[A-Za-z0-9]{36}/g, prefixLen: 6 },
];

export function maskSecrets(text: string): string {
  let result = text;
  for (const { pattern, prefixLen } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, (match) => match.slice(0, prefixLen) + "...MASKED");
  }
  return result;
}

export function formatModelName(model: string): string {
  return model.replace("claude-", "").replace(/-\d{8}$/, "");
}
