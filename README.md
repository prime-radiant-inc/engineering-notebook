# Engineering Notebook

A CLI tool that ingests [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [Codex](https://openai.com/index/introducing-codex/) session transcripts, generates LLM-powered daily summaries, and serves a web UI for browsing your engineering journal.

Think of it as an automatic engineering diary — it watches your AI coding sessions and distills them into a searchable, browsable narrative of what you built, what problems you hit, and what decisions you made.

![Journal view — three-panel layout with date index, entry detail, and conversation transcript](docs/screenshots/journal-view.gif)

## How It Works

1. **Ingest** — Scans directories of Claude Code and Codex JSONL session files, parses out the human-readable conversation (stripping tool calls, thinking blocks, etc.), and stores them in SQLite.
2. **Summarize** — Groups sessions by date and project, then uses Claude to write concise engineering journal entries with headlines, summaries, topics, and open questions.
3. **Serve** — Runs a web server with a browsable UI: daily journal, project timelines, calendar/Gantt view, session transcripts, full-text search, and an iCal feed.

## Install

Requires [Bun](https://bun.sh) v1.1+.

```sh
git clone https://github.com/prime-radiant-inc/engineering-notebook.git
cd engineering-notebook
bun install
bun link  # makes `engineering-notebook` available globally
```

## Quick Start

```sh
# 1. Ingest your sessions (defaults to ~/.claude/projects and ~/.codex/sessions)
engineering-notebook ingest

# 2. Generate journal summaries (requires ANTHROPIC_API_KEY)
engineering-notebook summarize --all

# 3. Browse your journal
engineering-notebook serve
# Open http://localhost:3000
```

## Web UI

The web interface has several views:

- **Journal** — Three-panel layout: date index, entries for the selected date, and entry detail with full conversation transcripts. Entries include headlines, summaries, topic tags, and open questions.
- **Projects** — Browse all projects sorted by recency. Each project shows a timeline of journal entries with on-demand summarization for new sessions.
- **Calendar** — Week and month views with Gantt-style bars showing project activity across dates. Days link back to the journal view.
- **Search** — Full-text search across journal entries and conversation transcripts with highlighted results.
- **Settings** — Configure sources, exclusions, remote sources, summary instructions, auto-sync interval, and day start hour. Includes an iCal feed URL for subscribing in your calendar app.

| ![Calendar/Gantt view](docs/screenshots/calendar-view.gif) | ![Search with highlighted results](docs/screenshots/search-view.gif) |
|:---:|:---:|
| Calendar/Gantt view | Full-text search |

Each session transcript includes a resume command (`claude --resume <id>`) with a copy button for picking up where you left off.

## Usage

### `engineering-notebook ingest`

Scan source directories and ingest session files into the database.

```sh
engineering-notebook ingest                    # scan default sources
engineering-notebook ingest --source ~/extra   # add an extra source directory
engineering-notebook ingest --force            # re-ingest already-processed sessions
```

### `engineering-notebook summarize`

Generate LLM summaries for ingested sessions.

```sh
engineering-notebook summarize --all                      # summarize everything unsummarized
engineering-notebook summarize --date 2026-02-22          # summarize (or re-summarize) a date
engineering-notebook summarize --project myapp            # summarize a specific project
engineering-notebook summarize --date 2026-02-22 --project myapp  # both filters
```

`--all` only visits dates that have no entry yet, so re-running it never rewrites
existing entries. Naming a date with `--date` **does** regenerate it, replacing
whatever is there. That is what you want for the current day: a day gets
summarized while you are still working, and re-running `--date today` folds in
everything since. Pair it with `--project` to regenerate a single project's entry.

### `engineering-notebook report`

Aggregate a week's journal entries into a status report.

```sh
engineering-notebook report                    # last completed week
engineering-notebook report --week 2026-W31    # a specific week
engineering-notebook report --stdout           # print without storing or exporting
```

Reports are stored with version history and exported to `reports_dir` as
`<week>.md`. Re-running creates a new version rather than overwriting, so the
record of what you already sent is preserved.

The prompt is a markdown template you control. Point `report_template_url` at a
file and the whole team generates reports in the same shape. Placeholders:
`{{week_label}}`, `{{week_start}}`, `{{week_end}}`, `{{entries}}`,
`{{open_questions}}`, `{{project_list}}`. Unknown placeholders are left as-is.

Every successful fetch is cached. If the URL is unreachable the cached copy is
used; if there is no cache, generation fails rather than silently falling back
to a differently-shaped default.

### `engineering-notebook serve`

Start the web server.

```sh
engineering-notebook serve              # default port 3000
engineering-notebook serve --port 8080  # custom port
```

The server auto-syncs remote sources and re-ingests on a configurable interval (default: 60 seconds).

## Configuration

Config lives at `~/.config/engineering-notebook/config.json`:

```json
{
  "sources": ["~/.claude/projects", "~/.codex/sessions"],
  "exclude": ["-private-tmp*", "*-skill-test-*"],
  "db_path": "~/.config/engineering-notebook/notebook.db",
  "port": 3000,
  "day_start_hour": 5,
  "summary_instructions": "",
  "remote_sources": [],
  "auto_sync_interval": 60
}
```

| Field                    | Description                                                                              | Default                                        |
| ------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `sources`                | Directories to scan for session files                                                    | `["~/.claude/projects", "~/.codex/sessions"]`  |
| `exclude`                | Glob patterns for directories to skip                                                    | `["-private-tmp*", "*-skill-test-*"]`          |
| `db_path`                | SQLite database location                                                                 | `~/.config/engineering-notebook/notebook.db`   |
| `port`                   | Web server port                                                                          | `3000`                                         |
| `day_start_hour`         | Hour (0-23) when a "day" starts (for grouping late-night sessions with the previous day) | `5`                                            |
| `summary_instructions`   | Custom instructions appended to the LLM summarization prompt                             | `""`                                           |
| `remote_sources`         | SSH remote sources to sync before ingesting                                              | `[]`                                           |
| `auto_sync_interval`     | Seconds between auto-syncs when serving                                                  | `60`                                           |
| `opencode`               | OpenCode session import (opt-in)                                                         | absent                                         |
| `summary_provider`       | Which model writes summaries and titles                                                  | Claude Haiku                                   |
| `week_start_day`         | First day of the reporting week (0 = Sunday, 1 = Monday)                                 | `1`                                            |
| `reports_dir`            | Where weekly report markdown is exported                                                 | `~/.config/engineering-notebook/reports`       |
| `report_template_url`    | URL of the report prompt template (unset uses shipped default)                           | absent                                         |
| `report_template_cache`  | Where the last successfully fetched template is cached                                   | absent                                         |
| `report_provider`        | Model for weekly reports (falls back to summary_provider when unset)                    | absent                                         |

### OpenCode sessions

OpenCode keeps its sessions in a single SQLite database rather than one file per
session, so they cannot be scanned like Claude Code and Codex sources. Enabling
this block exports each session to a staging directory of JSONL files during
`ingest`, which the normal scanner then picks up:

```json
{
  "opencode": {
    "enabled": true,
    "staging_dir": "~/.cache/engineering-notebook/opencode",
    "max_count": 200
  }
}
```

Sessions are enumerated from OpenCode's database (`opencode session list` only
reports the current directory's project, so it cannot see them all) and their
transcripts are exported with `opencode export`. A manifest of last-seen update
times keeps repeat syncs cheap — only changed sessions are re-exported. Omit
`max_count` to take everything.

Projects are keyed off each session's working directory, so OpenCode and Claude
Code work in the same repo on the same day lands in one journal entry.

### Choosing a model

Summaries and session titles are written by Claude Haiku through the Agent SDK
by default, which needs no API key. Any OpenAI-compatible endpoint can be used
instead — including a local llama.cpp server:

```json
{
  "summary_provider": {
    "type": "openai",
    "base_url": "http://your-host:8001/v1",
    "model": "gemma-4",
    "api_key_env": "SPARK_API_KEY",
    "max_tokens": 4000
  }
}
```

`api_key_env` names the environment variable holding the key — the key itself is
never stored in the config file. Reasoning models spend completion tokens
thinking before emitting any content, so keep `max_tokens` generous (it defaults
to 4000); too small a budget returns an empty response rather than a summary.

### Remote Sources

Sync session files from remote machines over SSH:

```json
{
  "remote_sources": [
    {
      "name": "workstation",
      "host": "work.local",
      "path": "~/.claude/projects",
      "enabled": true
    }
  ]
}
```

### iCal Feed

When the server is running, subscribe to the iCal feed at:

```
webcal://localhost:3000/api/calendar.ics
```

This creates calendar events for each journal entry, viewable in Apple Calendar, Google Calendar, Outlook, etc.

## Development

```sh
bun install
bun test          # run tests
bun src/index.ts  # run from source
```

## Tech Stack

- [Bun](https://bun.sh) — runtime, bundler, test runner, SQLite
- [Hono](https://hono.dev) — web framework
- [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-typescript) — LLM summarization (Claude Haiku)
- [HTMX](https://htmx.org) — interactive web UI without a JS framework

## License

Apache 2.0 — see [LICENSE](LICENSE).
