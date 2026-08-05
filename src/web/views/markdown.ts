import { escapeHtml } from "./helpers";

/**
 * Minimal markdown renderer for weekly reports.
 *
 * Deliberately small: reports use headings, bullets, bold and inline code, and
 * nothing else. A full markdown library would be a new dependency in a repo
 * that carries almost none.
 *
 * Security note: the input is model-generated text built from session
 * transcripts, so it is escaped FIRST and only then given structure. Every tag
 * this function emits is one it wrote itself — no markup can survive from the
 * source text. Do not reorder those two steps.
 */
export function renderMarkdown(md: string): string {
  if (!md.trim()) return "";

  const lines = escapeHtml(md).split("\n");
  const out: string[] = [];
  let inList = false;
  let paragraph: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    out.push(`<p>${inline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!inList) return;
    out.push("</ul>");
    inList = false;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "") {
      flushParagraph();
      closeList();
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      closeList();
      // The page title already owns <h1>, so '#' demotes to h2 and '##' stays h2.
      const level = Math.min(Math.max(heading[1]!.length, 2), 6);
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
      continue;
    }

    const bullet = /^[*-]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(bullet[1]!)}</li>`);
      continue;
    }

    closeList();
    paragraph.push(trimmed);
  }

  flushParagraph();
  closeList();
  return out.join("\n");
}

/** Inline spans. Operates on already-escaped text. */
function inline(text: string): string {
  return text
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
