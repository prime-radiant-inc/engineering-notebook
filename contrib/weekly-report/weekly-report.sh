#!/bin/zsh
#
# Generate the weekly status report for the week that just ended.
#
# Runs Monday at 05:15. With day_start_hour at 5 the previous logical week does
# not close until 05:00 Monday, so an earlier run would report on an incomplete
# week. 05:15 also lets a 05:05 nightly ingest finish, so the week's final day
# is summarized before the report reads it.

set -uo pipefail

[[ -f "$HOME/.zshenv" ]] && source "$HOME/.zshenv"
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

REPO="${NOTEBOOK_REPO:-$HOME/Developer/engineering-notebook}"
CONFIG_DIR="${NOTEBOOK_CONFIG:-$HOME/.config/engineering-notebook}"
LOG="$CONFIG_DIR/weekly-report.log"

exec >> "$LOG" 2>&1

if [[ -f "$LOG" && $(wc -c < "$LOG") -gt 1048576 ]]; then
  tail -c 262144 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
fi

echo "=== $(date '+%Y-%m-%d %H:%M:%S') — weekly report ==="
cd "$REPO" || { echo "FAIL: $REPO not found"; exit 1; }

# No --week: the CLI defaults to the last completed week.
bun src/index.ts report "$@"
status=$?
echo "=== done (exit $status) ==="
exit $status
