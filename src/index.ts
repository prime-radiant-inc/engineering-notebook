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

    // Timed after OpenCode staging, so the reported duration measures scanning
    // and ingest rather than a network-bound export.
    const startMs = Date.now();
    console.log(`Scanning ${sources.length} source(s)...`);
    const files: string[] = [];
    for (const s of sources) {
      const found = scanSources([s], config.exclude);
      files.push(...found);
      console.log(`  ${found.length.toLocaleString()} in ${s}`);
    }
    console.log(`Found ${files.length.toLocaleString()} session file(s)`);

    const isTty = process.stderr.isTTY;
    const barWidth = Math.max(20, Math.min(40, (process.stdout.columns ?? 80) - 30));
    const renderBar = (done: number, total: number): string => {
      const partials = "▏▎▍▌▋▊▉";
      const ratio = total > 0 ? Math.min(1, done / total) : 1;
      const eighths = Math.round(ratio * barWidth * 8);
      const full = Math.floor(eighths / 8);
      const partial = eighths % 8;
      const partialChar = partial > 0 && full < barWidth ? partials[partial - 1]! : "";
      const empty = Math.max(0, barWidth - full - (partialChar ? 1 : 0));
      return "█".repeat(full) + partialChar + " ".repeat(empty);
    };
    let lastTickMs = 0;
    const result = ingestSessions(files, db, force, (done, total) => {
      if (!isTty) return;
      const now = Date.now();
      if (now - lastTickMs < 100 && done < total) return;
      lastTickMs = now;
      const pct = total > 0 ? Math.floor((done / total) * 100) : 100;
      process.stderr.write(
        `\r\x1b[2K  [${renderBar(done, total)}] ${pct.toString().padStart(3)}% · ${done.toLocaleString()}/${total.toLocaleString()}`
      );
    });
    if (isTty) process.stderr.write("\r\x1b[2K");

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(
      `Ingested ${result.ingested.toLocaleString()} session(s) (${result.totalMessages.toLocaleString()} messages) in ${elapsed}s`
    );
    if (result.skipped > 0) {
      const parts: string[] = [];
      if (result.alreadyIngested) parts.push(`${result.alreadyIngested.toLocaleString()} already ingested`);
      if (result.empty) parts.push(`${result.empty.toLocaleString()} empty`);
      if (result.duplicateId) parts.push(`${result.duplicateId.toLocaleString()} duplicate id`);
      console.log(`Skipped ${result.skipped.toLocaleString()}: ${parts.join(", ")}`);
    }
    if (result.errors.length > 0) {
      console.log(`Errors: ${result.errors.length}`);
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
        provider: config.summary_provider,
        onProgress: (done, total, title) => console.log(`  [${done}/${total}] ${title}`),
      });
      console.log(`Generated ${generated}, skipped ${skipped}.`);
    } else {
      console.log("Pass --generate to also LLM-generate titles for the rest (or --limit N).");
    }
    closeDb();
    break;
  }
  case "config":
    console.log("TODO: config");
    break;
  default:
    console.log("Usage: notebook <ingest|summarize|serve|title|config>");
    process.exit(1);
}
