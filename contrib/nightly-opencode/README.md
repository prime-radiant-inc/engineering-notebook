# Nightly OpenCode summaries (macOS / launchd)

Regenerates the previous day's journal entries for every project that had
OpenCode activity, once a day, unattended.

Useful because OpenCode sessions arrive through the staging adapter rather than
as files on disk, so they are only picked up when `ingest` runs — and because a
day summarized while you are still working in it is summarized incomplete.

## Requirements

- The OpenCode source adapter, enabled in `config.json`
- `summarize --date` regenerating an existing entry (rather than skipping it)
- `bun`, `sqlite3`, `python3`, and the `opencode` CLI on `PATH`

## Install

```sh
cp summarize-opencode-day.sh ~/.config/engineering-notebook/
chmod +x ~/.config/engineering-notebook/summarize-opencode-day.sh

sed "s|__HOME__|$HOME|g" com.engineering-notebook.nightly.plist \
  > ~/Library/LaunchAgents/com.engineering-notebook.nightly.plist

launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.engineering-notebook.nightly.plist
```

Verify it registered, and check the schedule launchd actually recorded:

```sh
launchctl list | grep engineering-notebook
launchctl print gui/$UID/com.engineering-notebook.nightly | grep -E '"Hour"|"Minute"'
```

Run it by hand for a given day — worth doing once before trusting the schedule:

```sh
~/.config/engineering-notebook/summarize-opencode-day.sh 2026-07-31
tail -30 ~/.config/engineering-notebook/nightly.log
```

To test it the way launchd will actually run it, with a minimal environment:

```sh
env -i HOME="$HOME" PATH=/usr/bin:/bin /bin/zsh \
  ~/.config/engineering-notebook/summarize-opencode-day.sh
```

## Why 05:05

`day_start_hour` (default `5`) means a logical day runs 05:00 to 05:00, so
"yesterday" is not over until 05:00 today. A job at 00:01 would summarize a day
that still has five hours left in it, and those hours would then be locked out.
05:05 is the first moment the previous day is complete.

The script honours whatever `day_start_hour` is configured, reading it from
`config.json` and selecting sessions by logical date. Selecting on the calendar
date instead both picks projects whose work belongs to the previous day and
misses projects whose work belongs to this one.

## Scope and caveats

- **Projects, not sessions.** Journal entries are keyed by `(date, project)`, so
  a project you used with both OpenCode and Claude Code on the same day gets one
  entry covering both. The script selects *projects that had OpenCode activity*;
  it cannot summarize OpenCode sessions in isolation.
- **The checkout matters.** It runs `bun src/index.ts` from `NOTEBOOK_REPO`, so
  whatever branch is checked out there is what runs.
- **Secrets stay out of the plist.** The script sources `~/.zshenv`, so an API
  key referenced by `summary_provider.api_key_env` is picked up from your shell
  environment rather than being copied into a file launchd reads.
- **Logs** go to `~/.config/engineering-notebook/nightly.log`, self-trimming at
  1 MB. launchd's own stdout/stderr go to `nightly.launchd.log`.
