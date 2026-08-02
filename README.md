# Engineering Notebook

A CLI tool that ingests [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Codex](https://openai.com/index/introducing-codex/), and [Cursor](https://cursor.com) session transcripts, generates LLM-powered daily summaries, and serves a web UI for browsing your engineering journal.

Think of it as an automatic engineering diary — it watches your AI coding sessions and distills them into a searchable, browsable narrative of what you built, what problems you hit, and what decisions you made.

![Journal view — three-panel layout with date index, entry detail, and conversation transcript](docs/screenshots/journal-view.gif)

## How It Works

1. **Ingest** — Scans directories of Claude Code, Codex, and Cursor JSONL session files, parses out the human-readable conversation (stripping tool calls, thinking blocks, etc.), and stores them in SQLite.
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
engineering-notebook summarize --date 2026-02-22          # summarize a specific date
engineering-notebook summarize --project myapp            # summarize a specific project
engineering-notebook summarize --date 2026-02-22 --project myapp  # both filters
```

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

| Field                  | Description                                                                              | Default                                        |
| ---------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `sources`              | Directories to scan for session files                                                    | `["~/.claude/projects", "~/.codex/sessions"]`  |
| `exclude`              | Glob patterns for directories to skip                                                    | `["-private-tmp*", "*-skill-test-*"]`          |
| `db_path`              | SQLite database location                                                                 | `~/.config/engineering-notebook/notebook.db`   |
| `port`                 | Web server port                                                                          | `3000`                                         |
| `day_start_hour`       | Hour (0-23) when a "day" starts (for grouping late-night sessions with the previous day) | `5`                                            |
| `summary_instructions` | Custom instructions appended to the LLM summarization prompt                             | `""`                                           |
| `remote_sources`       | SSH remote sources to sync before ingesting                                              | `[]`                                           |
| `auto_sync_interval`   | Seconds between auto-syncs when serving                                                  | `60`                                           |
| `opencode`             | OpenCode session import (opt-in)                                                         | absent                                         |
| `summary_provider`     | Which model writes summaries and session titles                                          | Claude Haiku                                   |

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

Journal summaries and session titles are written by Claude Haiku through the
Agent SDK by default, which needs no API key. Any OpenAI-compatible endpoint can be used
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

## Cursor support

Cursor sessions live under `~/.cursor/projects` (Cursor's `agent-transcripts/`
layout). This source is **not** scanned by default — add it explicitly:

```sh
engineering-notebook ingest --source ~/.cursor/projects
```

Or add `~/.cursor/projects` to the `sources` array in your config.

Cursor's transcript format is leaner than Claude Code's or Codex's, so a few
caveats apply:

- **Timestamps come from file modification times.** Cursor transcripts contain no
  per-message timestamps, so a session's start and end are taken from the file's
  creation and last-modified times, and per-message times are approximate. Copying
  or restoring transcript files can reset these.
- **Project names are the raw encoded directory string** (for example
  `Users-username-GitRepos-my-repo`). Cursor does not record the working directory,
  and its directory names encode the path lossily — both `/` and `.` collapse to
  `-` — so the name is shown verbatim rather than guessed at.
- **Cursor sessions do not auto-merge** with the same repository's Claude Code or
  Codex sessions, which group by the real working-directory name.
- **Some Cursor projects appear under an opaque numeric id** (for example
  `1700000000000`) when Cursor stored no recoverable path.

Planned improvements (not yet implemented): stripping `<attached_files>` and
terminal-selection wrappers from Cursor messages, and recovering real project
names via Cursor's `workspaceStorage` mapping.

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
