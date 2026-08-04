#!/usr/bin/env bun

import { loadConfig, expandPath } from "./config";
import { initDb, closeDb } from "./db";
import { scanSources, ingestSessions } from "./ingest";

const command = process.argv[2];

switch (command) {
  case "ingest": {
    const config = loadConfig();
    const db = initDb(config.db_path);

    const force = process.argv.includes("--force");

    // Collect sources: config + any --source args
    const sources = config.sources.map(expandPath);
    const sourceIdx = process.argv.indexOf("--source");
    if (sourceIdx !== -1 && process.argv[sourceIdx + 1]) {
      sources.push(expandPath(process.argv[sourceIdx + 1]!));
    }

    // Sync remote sources
    const remoteSources = config.remote_sources?.filter((s) => s.enabled) || [];
    if (remoteSources.length > 0) {
      const { syncAllRemoteSources } = await import("./sync");
      console.log(`Syncing ${remoteSources.length} remote source(s)...`);
      const syncResult = await syncAllRemoteSources(remoteSources, (r) => {
        if (r.success) console.log(`  \u2713 ${r.name}`);
        else console.log(`  \u2717 ${r.name}: ${r.error}`);
      });
      sources.push(...syncResult.cachedPaths);
      if (syncResult.errors.length > 0) {
        console.log(
          `Sync errors: ${syncResult.errors.length} (continuing with local sources)`
        );
      }
    }

    // Stage OpenCode sessions, which live in a SQLite DB rather than one file
    // per session, into a scannable directory of JSONL files.
    if (config.opencode?.enabled) {
      const { syncOpenCodeSessions, cliRunner } = await import("./opencode");
      const stagingDir = expandPath(config.opencode.staging_dir);
      console.log("Syncing OpenCode sessions...");
      try {
        const ocResult = await syncOpenCodeSessions(stagingDir, cliRunner(), {
          maxCount: config.opencode.max_count,
        });
        console.log(
          `  OpenCode: ${ocResult.written} exported, ${ocResult.skipped} unchanged`
        );
        for (const err of ocResult.errors.slice(0, 5)) {
          console.log(`  ✗ ${err}`);
        }
        sources.push(stagingDir);
      } catch (err) {
        console.log(
          `  ✗ OpenCode sync failed: ${err instanceof Error ? err.message : err}`
        );
      }
    }

    console.log(`Scanning ${sources.length} source(s)...`);
    const files = scanSources(sources, config.exclude);
    console.log(`Found ${files.length} session file(s)`);

    const result = ingestSessions(files, db, force);
    console.log(
      `Ingested: ${result.ingested}, Skipped: ${result.skipped}, Errors: ${result.errors.length}`
    );
    if (result.errors.length > 0) {
      for (const err of result.errors.slice(0, 10)) {
        console.error(`  ${err}`);
      }
    }
    closeDb();
    break;
  }
  case "summarize": {
    const config = loadConfig();
    const db = initDb(config.db_path);

    const dateIdx = process.argv.indexOf("--date");
    const filterDate = dateIdx !== -1 ? process.argv[dateIdx + 1] : undefined;
    const projectIdx = process.argv.indexOf("--project");
    const filterProject = projectIdx !== -1 ? process.argv[projectIdx + 1] : undefined;
    const all = process.argv.includes("--all");

    if (!filterDate && !filterProject && !all) {
      const { groupSessionsByDateAndProject } = await import("./summarize");
      const groups = groupSessionsByDateAndProject(db, undefined, undefined, config.day_start_hour);
      console.log(`Found ${groups.length} unsummarized date+project group(s).`);
      console.log("Use --all to summarize everything, or --date/--project to filter.");
      closeDb();
      break;
    }

    const { summarizeAll } = await import("./summarize");
    const { providerModel } = await import("./llm");
    console.log(`Summarizing with ${providerModel(config.summary_provider)}...`);
    const result = await summarizeAll(db, filterDate, filterProject, (done, total, group) => {
      console.log(`[${done + 1}/${total}] Summarizing ${group.projectName} (${group.date})...`);
    }, config.day_start_hour, config.summary_instructions, config.summary_provider);

    console.log(`Summarized: ${result.summarized}, Skipped: ${result.skipped}, Errors: ${result.errors.length}`);
    if (result.skipped > 0) {
      for (const reason of result.skipReasons) {
        console.log(`  \u2298 ${reason}`);
      }
    }
    if (result.errors.length > 0) {
      for (const err of result.errors.slice(0, 10)) {
        console.error(`  ${err}`);
      }
    }
    closeDb();
    break;
  }
  case "serve": {
    const config = loadConfig();
    const db = initDb(config.db_path);
    const { SyncManager } = await import("./sync");
    const syncManager = new SyncManager(config, db);
    const { createApp } = await import("./web/server");
    const react = process.argv.includes("--react");
    const app = createApp(db, syncManager, { react });
    syncManager.startTimer();

    const port = (() => {
      const portIdx = process.argv.indexOf("--port");
      return portIdx !== -1 ? parseInt(process.argv[portIdx + 1]!) : config.port;
    })();

    console.log(`Engineering Notebook running at http://localhost:${port}`);
    Bun.serve({
      fetch: app.fetch,
      port,
    });
    break;
  }
  case "title": {
    const config = loadConfig();
    const db = initDb(config.db_path);
    const { applyDesktopTitles, backfillTitles } = await import("./titles");
    const applied = applyDesktopTitles(db);
    console.log(`Applied ${applied} Claude Desktop titles.`);
    const generate = process.argv.includes("--generate") || process.argv.includes("--all");
    if (generate) {
      const limitIdx = process.argv.indexOf("--limit");
      const limit = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1]!, 10) : undefined;
      console.log("Generating titles for Claude Code sessions without one…");
      const { generated, skipped } = await backfillTitles(db, {
        limit,
        onProgress: (done, total, title) => console.log(`  [${done}/${total}] ${title}`),
      });
      console.log(`Generated ${generated}, skipped ${skipped}.`);
    } else {
      console.log("Pass --generate to also LLM-generate titles for the rest (or --limit N).");
    }
    closeDb();
    break;
  }
  case "report": {
    const config = loadConfig();
    const db = initDb(config.db_path);

    const weekIdx = process.argv.indexOf("--week");
    const weekArg = weekIdx !== -1 ? process.argv[weekIdx + 1] : undefined;
    const toStdout = process.argv.includes("--stdout");

    const { weekRangeForLabel, lastCompletedWeek } = await import("./week");
    const startDay = config.week_start_day ?? 1;
    const today = new Date().toISOString().slice(0, 10);
    const range = weekArg
      ? weekRangeForLabel(weekArg, startDay)
      : lastCompletedWeek(today, startDay);

    const { resolveTemplate } = await import("./report-template");
    const { generateReport, exportMarkdown } = await import("./reports");
    const { providerModel } = await import("./llm");

    const provider = config.report_provider ?? config.summary_provider;
    console.log(`Generating ${range.label} (${range.start} to ${range.end}) with ${providerModel(provider)}...`);

    try {
      const template = await resolveTemplate({
        url: config.report_template_url,
        cachePath: expandPath(
          config.report_template_cache ?? "~/.config/engineering-notebook/report-template.cache.md"
        ),
      });
      if (template.source === "cache") {
        console.log("  ! template URL unreachable — using the last cached copy");
      }

      if (toStdout) {
        const { buildPrompt } = await import("./reports");
        const { complete } = await import("./llm");
        const { prompt } = buildPrompt(db, range, template);
        console.log(await complete(prompt, provider));
        closeDb();
        break;
      }

      const result = await generateReport(db, { range, template, provider });
      const dir = expandPath(config.reports_dir ?? "~/.config/engineering-notebook/reports");
      const path = exportMarkdown(dir, range.label, result.markdown);
      console.log(`Wrote ${range.label} v${result.version} to ${path}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/^No entries for/.test(msg)) {
        console.log(`${msg} — nothing to report.`);
      } else {
        console.error(`Report failed: ${msg}`);
        process.exitCode = 1;
      }
    }

    closeDb();
    break;
  }
  case "config":
    console.log("TODO: config");
    break;
  default:
    console.log("Usage: notebook <ingest|summarize|report|serve|config>");
    process.exit(1);
}
