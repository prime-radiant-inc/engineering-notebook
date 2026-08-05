/**
 * Report template resolution.
 *
 * The prompt is a user-authored markdown file, optionally fetched from a URL so
 * a manager can set the format for a whole team. Every successful fetch is
 * cached; a failed fetch falls back to that cache. When a URL is configured and
 * neither the fetch nor a cache succeeds, generation fails rather than quietly
 * falling back to the shipped default — a differently-shaped report going out
 * under someone's name is worse than no report.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";

export type TemplateSource = "url" | "cache" | "default";

export type ResolvedTemplate = {
  text: string;
  source: TemplateSource;
};

/** Shipped default, used when no url is configured. */
export const DEFAULT_TEMPLATE: string = readFileSync(
  join(import.meta.dir, "../contrib/report-templates/weekly-default.md"),
  "utf-8"
);

export async function resolveTemplate(opts: {
  url?: string;
  cachePath: string;
  fetchImpl?: (input: string) => Promise<Response>;
}): Promise<ResolvedTemplate> {
  if (!opts.url) return { text: DEFAULT_TEMPLATE, source: "default" };

  const doFetch = opts.fetchImpl ?? fetch;
  let text: string;
  try {
    const res = await doFetch(opts.url);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    text = await res.text();
  } catch (err) {
    if (existsSync(opts.cachePath)) {
      return { text: readFileSync(opts.cachePath, "utf-8"), source: "cache" };
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not fetch report template from ${opts.url} (${detail}) and no cached copy exists at ${opts.cachePath}`
    );
  }

  // The fetch already succeeded — always return the fresh text with source
  // "url". A cache-write failure here must not fall back to a stale cache
  // and misreport its source.
  try {
    mkdirSync(dirname(opts.cachePath), { recursive: true });
    writeFileSync(opts.cachePath, text);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(`Warning: could not write report template cache at ${opts.cachePath}: ${detail}`);
  }
  return { text, source: "url" };
}

/** Substitute {{name}} placeholders. Unknown placeholders are left untouched. */
export function renderTemplate(text: string, vars: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in vars ? vars[name]! : whole
  );
}
