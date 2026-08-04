# Weekly status report (macOS / launchd)

Generates the previous week's status report every Monday at 05:15.

## Install

```sh
cp weekly-report.sh ~/.config/engineering-notebook/
chmod +x ~/.config/engineering-notebook/weekly-report.sh

sed "s|__HOME__|$HOME|g" com.engineering-notebook.weekly.plist \
  > ~/Library/LaunchAgents/com.engineering-notebook.weekly.plist

launchctl bootstrap gui/$UID ~/Library/LaunchAgents/com.engineering-notebook.weekly.plist
```

Verify, and test it the way launchd will run it:

```sh
launchctl print gui/$UID/com.engineering-notebook.weekly | grep -E '"Weekday"|"Hour"|"Minute"'
env -i HOME="$HOME" PATH=/usr/bin:/bin /bin/zsh ~/.config/engineering-notebook/weekly-report.sh --week 2026-W31
```

## Why 05:15 Monday

With `day_start_hour` at 5, the previous logical week does not close until 05:00
Monday. An earlier run reports on an incomplete week — and because reports are
versioned rather than frozen, a later re-run corrects it without losing history.

## Failure

If the configured model is unreachable the run fails, logs to
`weekly-report.log`, and nothing retries. Re-run by hand; versioning means this
is not destructive.
