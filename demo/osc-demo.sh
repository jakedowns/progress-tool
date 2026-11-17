#!/usr/bin/env bash
#
# OSC 9;4 demo for the out-of-band progress relay.
#
# Runs a fake "build" that reports progress natively with OSC 9;4 terminal
# sequences (the ConEmu / Windows Terminal convention also emitted by Gradle's
# rich console, mise, PowerShell 7.4+, ...) and pipes it through progress-relay.
#
# What to expect:
#   - The relay parses the sequences at the chunk level: state 1 -> percent,
#     state 3 -> indeterminate, and the exit code maps to done/error.
#   - The agent (you) never polls: all telemetry is zero-token, written by the
#     relay process into the shared state file (~/.opencode-progress-state.json
#     unless PROGRESS_STATE_PATH is set).
#   - Bonus: because the relay tees raw output by default, a real terminal that
#     supports OSC 9;4 (Windows Terminal, Ghostty, iTerm2 3.6.6+, WezTerm,
#     Konsole) will show the tab's native progress bar too.
#
# Watch it live:  ./launch-gui.sh   (in a second terminal, before running this)
#
# Usage:  bash demo/osc-demo.sh          (from the repo root, or anywhere)
#         PROGRESS_STATE_PATH=/tmp/x bash demo/osc-demo.sh

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RELAY_BIN=(node "$ROOT/mcp-server/index.js" relay)
ID="${PROGRESS_DEMO_ID:-osc-demo}"

STATE_ARGS=()
if [ -n "${PROGRESS_STATE_PATH:-}" ]; then
  STATE_ARGS+=(--state-path "$PROGRESS_STATE_PATH")
fi

echo "demo: piping a fake OSC 9;4 build through progress-relay (task id: $ID)"
echo "demo: run ./launch-gui.sh in another terminal to watch the indicator"

"${RELAY_BIN[@]}" --id "$ID" --title "OSC 9;4 demo build" "${STATE_ARGS[@]}" -- bash -c '
for i in 0 10 20 30 40 50 60 70; do
  printf "\e]9;4;1;%d\a" "$i"
  echo "compiling module_$i"
  sleep 0.25
done
printf "\e]9;4;3\a"
echo "linking (indeterminate)"
sleep 0.5
printf "\e]9;4;1;95\a"
echo "packaging"
sleep 0.25
'

status=$?
echo "demo: relay exited $status — task \"$ID\" should now be done at 100%"
echo "demo: inspect the state file with: cat \${PROGRESS_STATE_PATH:-$HOME/.opencode-progress-state.json}"
exit $status
