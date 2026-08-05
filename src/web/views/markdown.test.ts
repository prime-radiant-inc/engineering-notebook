import { describe, test, expect } from "bun:test";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  test("escapes HTML before applying markdown, so model output cannot inject markup", () => {
    const html = renderMarkdown("## Heading\n\n<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("escapes ampersands without double-escaping entities it produces", () => {
    expect(renderMarkdown("A & B")).toContain("A &amp; B");
  });

  test("renders level-two headings", () => {
    expect(renderMarkdown("## Summary")).toContain("<h2>Summary</h2>");
  });

  test("renders bullet lists, grouping consecutive items into one list", () => {
    const html = renderMarkdown("* one\n* two");
    expect(html).toContain("<ul>");
    expect((html.match(/<li>/g) || []).length).toBe(2);
    expect((html.match(/<ul>/g) || []).length).toBe(1);
  });

  test("accepts dashes as bullets too", () => {
    expect(renderMarkdown("- only")).toContain("<li>only</li>");
  });

  test("renders bold spans", () => {
    expect(renderMarkdown("a **bold** word")).toContain("<strong>bold</strong>");
  });

  test("renders inline code", () => {
    expect(renderMarkdown("run `bun test` now")).toContain("<code>bun test</code>");
  });

  test("wraps prose in paragraphs", () => {
    expect(renderMarkdown("just prose")).toContain("<p>just prose</p>");
  });

  test("returns an empty string for empty input rather than throwing", () => {
    expect(renderMarkdown("")).toBe("");
  });

  test("does not let a bold marker smuggle a tag", () => {
    const html = renderMarkdown("**<img src=x onerror=1>**");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });
});
