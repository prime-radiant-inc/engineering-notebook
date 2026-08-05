import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { resolveTemplate, renderTemplate } from "./report-template";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("renderTemplate", () => {
  test("substitutes known placeholders", () => {
    const out = renderTemplate("Week {{week_label}} for {{project_list}}", {
      week_label: "2026-W31",
      project_list: "alpha, beta",
    });
    expect(out).toBe("Week 2026-W31 for alpha, beta");
  });

  test("leaves unknown placeholders untouched rather than erroring", () => {
    const out = renderTemplate("{{week_label}} {{not_a_thing}}", { week_label: "2026-W31" });
    expect(out).toBe("2026-W31 {{not_a_thing}}");
  });
});

describe("resolveTemplate", () => {
  let dir: string;
  let cachePath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "en-template-"));
    cachePath = join(dir, "template.cache.md");
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("uses the built-in default when no url is configured", async () => {
    const r = await resolveTemplate({ cachePath });
    expect(r.source).toBe("default");
    expect(r.text).toContain("{{entries}}");
  });

  test("fetches from the url and writes the cache", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("REMOTE {{entries}}") });
    try {
      const r = await resolveTemplate({ url: `http://localhost:${server.port}/t.md`, cachePath });
      expect(r.source).toBe("url");
      expect(r.text).toBe("REMOTE {{entries}}");
      expect(readFileSync(cachePath, "utf-8")).toBe("REMOTE {{entries}}");
    } finally {
      server.stop(true);
    }
  });

  test("falls back to the cached copy when the fetch fails", async () => {
    writeFileSync(cachePath, "CACHED {{entries}}");
    const r = await resolveTemplate({
      url: "http://localhost:1/unreachable.md",
      cachePath,
      fetchImpl: () => Promise.reject(new Error("connection refused")),
    });
    expect(r.source).toBe("cache");
    expect(r.text).toBe("CACHED {{entries}}");
  });

  test("throws when the fetch fails and no cache exists", async () => {
    expect(
      resolveTemplate({
        url: "http://localhost:1/unreachable.md",
        cachePath,
        fetchImpl: () => Promise.reject(new Error("connection refused")),
      })
    ).rejects.toThrow(/no cached copy/i);
  });

  test("treats a non-200 response as a failure", async () => {
    writeFileSync(cachePath, "CACHED");
    const server = Bun.serve({ port: 0, fetch: () => new Response("nope", { status: 500 }) });
    try {
      const r = await resolveTemplate({ url: `http://localhost:${server.port}/t.md`, cachePath });
      expect(r.source).toBe("cache");
    } finally {
      server.stop(true);
    }
  });
});
