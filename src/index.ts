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

    console.log(`Scanning ${sources.length} source(s)...`);
    const files = scanSources(sources, config.exclude);
    console.log(`Found ${files.length} session file(s)`);

    const result = ingestSessions(files, db, force);
    console.log(
      `Ingested: ${result.ingested}, Re-ingested: ${result.reingested}, Skipped: ${result.skipped}, Errors: ${result.errors.length}`
    );
    if (result.invalidatedJournals > 0) {
      console.log(
        `Invalidated ${result.invalidatedJournals} stale journal entr${result.invalidatedJournals === 1 ? "y" : "ies"} — re-run \`summarize\` to regenerate.`
      );
    }
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
    const why = process.argv.includes("--why");

    if (why) {
      if (!filterDate || !filterProject) {
        console.error("Usage: engineering-notebook summarize --why --date <date> --project <project>");
        closeDb();
        process.exit(1);
      }
      const { groupSessionsByDateAndProject, explainGroup } = await import("./summarize");
      const groups = groupSessionsByDateAndProject(db, filterDate, filterProject, config.day_start_hour);
      if (groups.length === 0) {
        console.error(`No unsummarized group found for date=${filterDate} project=${filterProject}.`);
        console.error("Note: --why operates on unsummarized groups. To re-audit a summarized one, delete its journal_entries row first.");
        closeDb();
        process.exit(1);
      }
      const target = groups[0]!;
      const explained = await explainGroup(target, config);
      const rule = "-".repeat(60);
      console.log(`# Audit: ${target.projectName} (${target.date})`);
      console.log(`# Sessions: ${target.sessionIds.length}, conversation chunks: ${target.conversations.length}`);
      console.log(`# Model: ${explained.modelUsed}\n`);
      if (explained.requestBody) {
        console.log(`## Request body sent\n${rule}\n${JSON.stringify(explained.requestBody, null, 2)}\n${rule}\n`);
      } else {
        console.log(`## Prompt sent\n${rule}\n${explained.prompt}\n${rule}\n`);
      }
      console.log(`## Raw response\n${rule}\n${explained.rawResponse}\n${rule}\n`);
      console.log(`## Parsed`);
      if (explained.parsed.skipped) {
        console.log(`SKIPPED: ${explained.parsed.skipReason}`);
      } else {
        console.log(`HEADLINE: ${explained.parsed.headline}`);
        console.log(`SUMMARY: ${explained.parsed.summary}`);
        console.log(`TOPICS: ${JSON.stringify(explained.parsed.topics)}`);
        console.log(`OPEN_QUESTIONS: ${JSON.stringify(explained.parsed.openQuestions)}`);
      }
      closeDb();
      break;
    }

    if (!filterDate && !filterProject && !all) {
      const { groupSessionsByDateAndProject } = await import("./summarize");
      const groups = groupSessionsByDateAndProject(db, undefined, undefined, config.day_start_hour);
      console.log(`Found ${groups.length} unsummarized date+project group(s).`);
      console.log("Use --all to summarize everything, or --date/--project to filter.");
      closeDb();
      break;
    }

    const { summarizeAll } = await import("./summarize");
    const result = await summarizeAll(
      db,
      filterDate,
      filterProject,
      (done, total, group) => {
        console.log(
          `[${done + 1}/${total}] Summarizing ${group.projectName} (${group.date})...`
        );
      },
      config.day_start_hour,
      config,
      (done, total, outcome) => {
        const tag = `[${done}/${total}]`;
        const where = `${outcome.group.projectName} (${outcome.group.date})`;
        if (outcome.kind === "summarized") {
          console.log(`${tag} \u2713 ${where}`);
        } else if (outcome.kind === "skipped") {
          console.log(`${tag} \u2298 ${where}: ${outcome.reason}`);
        } else {
          console.error(`${tag} \u2717 ${where}: ${outcome.error}`);
        }
      }
    );

    console.log(
      `\nSummarized: ${result.summarized}, Skipped: ${result.skipped}, Errors: ${result.errors.length}`
    );
    if (result.errors.length > 0) {
      console.error("\nErrors:");
      for (const err of result.errors.slice(0, 10)) {
        console.error(`  ${err}`);
      }
    }
    closeDb();
    break;
  }
  case "rollup": {
    const config = loadConfig();
    const db = initDb(config.db_path);

    const periodFlag = process.argv.indexOf("--period");
    const period = periodFlag !== -1 ? process.argv[periodFlag + 1] : "week";
    if (period !== "week") {
      console.error(`Only --period week is supported in this version (got: ${period}).`);
      closeDb();
      process.exit(1);
    }

    const projectIdx = process.argv.indexOf("--project");
    const filterProject = projectIdx !== -1 ? process.argv[projectIdx + 1] : undefined;
    const weekIdx = process.argv.indexOf("--week");
    const filterWeek = weekIdx !== -1 ? process.argv[weekIdx + 1] : undefined;
    const all = process.argv.includes("--all");

    const { findUnrolledWeeks, rollupWeek, weekStart } = await import("./rollup");

    let targets = findUnrolledWeeks(db);
    if (filterProject) targets = targets.filter((t) => t.projectId === filterProject);
    if (filterWeek) {
      const monday = weekStart(filterWeek);
      targets = targets.filter((t) => t.weekMonday === monday);
    }

    if (targets.length === 0) {
      console.log("No unrolled (week, project) tuples match the filters.");
      closeDb();
      break;
    }

    if (!all && !filterProject && !filterWeek) {
      console.log(`Found ${targets.length} unrolled (week, project) tuple(s).`);
      console.log("Use --all to roll up everything, or --project/--week to filter.");
      closeDb();
      break;
    }

    let rolled = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const t = targets[i]!;
      const tag = `[${i + 1}/${targets.length}]`;
      console.log(`${tag} Rolling up ${t.projectName} (week of ${t.weekMonday}, ${t.entryCount} daily entries)...`);
      try {
        const result = await rollupWeek(db, t.projectId, t.weekMonday, config);
        if (result.skipped) {
          skipped++;
          console.log(`${tag} ⊘ ${t.projectName} (week of ${t.weekMonday}): ${result.skipReason}`);
        } else {
          rolled++;
          console.log(`${tag} ✓ ${t.projectName} (week of ${t.weekMonday}): ${result.headline}`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`${t.projectName} week of ${t.weekMonday}: ${msg}`);
        console.error(`${tag} ✗ ${t.projectName} (week of ${t.weekMonday}): ${msg}`);
      }
    }

    console.log(`\nRolled up: ${rolled}, Skipped: ${skipped}, Errors: ${errors.length}`);
    closeDb();
    break;
  }
  case "serve": {
    const config = loadConfig();
    const db = initDb(config.db_path);
    const { SyncManager } = await import("./sync");
    const syncManager = new SyncManager(config, db);
    const { createApp } = await import("./web/server");
    const app = createApp(db, syncManager);
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
  case "config":
    console.log("TODO: config");
    break;
  default:
    console.log("Usage: notebook <ingest|summarize|rollup|serve|config>");
    process.exit(1);
}
