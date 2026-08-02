#!/bin/zsh
#
# Summarize a day's OpenCode work.
#
# Ingests first, so OpenCode sessions are staged out of OpenCode's SQLite
# database, then regenerates the journal entry for every project that had
# OpenCode activity on the target day.
#
# Usage:  summarize-opencode-day.sh [YYYY-MM-DD]
#         Defaults to yesterday. See README.md for the launchd wiring.
#
# Environment:
#   NOTEBOOK_REPO    checkout to run from   (default ~/Developer/engineering-notebook)
#   NOTEBOOK_CONFIG  config directory       (default ~/.config/engineering-notebook)

set -uo pipefail

# launchd starts with a minimal environment. Sourcing the shell env picks up
# whatever the configured summary provider needs (e.g. an API key variable).
[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:$PATH"

REPO="${NOTEBOOK_REPO:-$HOME/Developer/engineering-notebook}"
CONFIG_DIR="${NOTEBOOK_CONFIG:-$HOME/.config/engineering-notebook}"
DB="$CONFIG_DIR/notebook.db"
LOG="$CONFIG_DIR/nightly.log"

exec >> "$LOG" 2>&1

# Trim the log rather than letting it grow without bound.
if [[ -f "$LOG" && $(wc -c < "$LOG") -gt 1048576 ]]; then
  tail -c 262144 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

DAY="${1:-$(date -v-1d +%Y-%m-%d)}"
echo "=== $(date '+%Y-%m-%d %H:%M:%S') — OpenCode summary for $DAY ==="

cd "$REPO" || { echo "FAIL: $REPO not found"; exit 1; }

if ! bun src/index.ts ingest --force; then
  echo "FAIL: ingest failed"
  exit 1
fi

# Select by *logical* date, the same way summarize groups sessions. With
# day_start_hour at 5, a session begun at 01:00 belongs to the previous day;
# selecting on the calendar date would pick projects whose work summarize then
# declines to group, and miss projects whose work it does.
HOUR=$(python3 -c "import json;print(json.load(open('$CONFIG_DIR/config.json')).get('day_start_hour',5))")

projects=$(sqlite3 "$DB" \
  "SELECT DISTINCT project_id FROM sessions
   WHERE id LIKE 'ses_%'
     AND date(datetime(started_at, '-$HOUR hours')) = '$DAY';")

if [[ -z "$projects" ]]; then
  echo "no OpenCode sessions for $DAY — nothing to summarize"
  echo "=== done ==="
  exit 0
fi

failed=0
echo "$projects" | while IFS= read -r project; do
  [[ -n "$project" ]] || continue
  echo "--- $project ---"
  bun src/index.ts summarize --date "$DAY" --project "$project" || failed=1
done

echo "=== done (exit $failed) ==="
exit $failed
