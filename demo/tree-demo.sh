#!/usr/bin/env bash
#
# Nested task-tree demo for the progress tool.
#
# Builds a two-level task tree — a parent "release pipeline" with child tasks,
# one of which has its own grandchildren — using only progress-emit (control
# plane) and progress-relay (data plane, wrapped background commands).
#
# Tree:
#   tree-demo            (parent; status/progress ROLL UP from children)
#   ├── build            (its own progress also rolls up from grandchildren)
#   │   ├── compile
#   │   └── link
#   ├── test-unit
#   └── test-e2e
#
# What to expect:
#   - Children run as real background processes; the relays stream their
#     output into the state file at zero token cost.
#   - The parent is never "updated" with percentages: parent status and
#     progress are a read-time roll-up of the children (spec §5.6), so the
#     GUI shows the tree converging live while the agent spends two tokens.
#   - Set PROGRESS_TREE_DEMO_FAIL=1 to make test-e2e fail and watch the error
#     roll all the way up to the parent.
#
# Watch it live:  ./launch-gui.sh   (in a second terminal, before running this)
#
# Usage:  bash demo/tree-demo.sh
#         PROGRESS_TREE_DEMO_FAIL=1 bash demo/tree-demo.sh

set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BIN=(node "$ROOT/mcp-server/index.js")
EMIT=("${BIN[@]}" emit)
RELAY=("${BIN[@]}" relay)
PARENT="${PROGRESS_TREE_DEMO_ID:-tree-demo}"

STATE_ARGS=()
if [ -n "${PROGRESS_STATE_PATH:-}" ]; then
  STATE_ARGS+=(--state-path "$PROGRESS_STATE_PATH")
fi

echo "demo: building a nested task tree under id \"$PARENT\""
echo "demo: run ./launch-gui.sh in another terminal to watch the roll-up live"

"${EMIT[@]}" --id "$PARENT" --status running --title "Release pipeline demo" --detail "build · test-unit · test-e2e" "${STATE_ARGS[@]}"

# --- build (child), with compile + link as grandchildren ------------------
"${RELAY[@]}" --id build --parent "$PARENT" --title "Build" --detail "compile + link running" "${STATE_ARGS[@]}" -- sleep 1.4 &
BUILD_PID=$!
"${RELAY[@]}" --id compile --parent build --title "Compile" -- bash -c 'for i in 1 2 3; do echo "compiling unit_$i"; sleep 0.3; done' "${STATE_ARGS[@]}" &
COMPILE_PID=$!
"${RELAY[@]}" --id link --parent build --title "Link" -- bash -c 'echo "linking binaries"; sleep 0.7; echo "linked"' "${STATE_ARGS[@]}" &
LINK_PID=$!

# --- test-unit (child) -----------------------------------------------------
"${RELAY[@]}" --id test-unit --parent "$PARENT" --title "Unit tests" -- bash -c 'echo "unit: auth"; sleep 0.4; echo "unit: billing 6/10"; sleep 0.4; echo "unit: 12/12 passed"' "${STATE_ARGS[@]}" &
UNIT_PID=$!

# --- test-e2e (child; optionally fails to demo error roll-up) --------------
E2E_BODY="echo 'e2e: login flow'; sleep 0.5; echo 'e2e: checkout 50%'; sleep 0.5; echo 'e2e: all flows passed'"
if [ -n "${PROGRESS_TREE_DEMO_FAIL:-}" ]; then
  E2E_BODY="echo 'e2e: login flow'; sleep 0.5; echo 'e2e: checkout 50%'; sleep 0.4; echo 'e2e: payment regression'; exit 3"
fi
"${RELAY[@]}" --id test-e2e --parent "$PARENT" --title "E2E tests" -- bash -c "$E2E_BODY" "${STATE_ARGS[@]}" &
E2E_PID=$!

FAILED=0
for pid in "$BUILD_PID" "$COMPILE_PID" "$LINK_PID" "$UNIT_PID" "$E2E_PID"; do
  wait "$pid" || FAILED=1
done

if [ "$FAILED" -ne 0 ]; then
  "${EMIT[@]}" --id "$PARENT" --status error --detail "a child failed — roll-up already showed it" "${STATE_ARGS[@]}"
  echo "demo: pipeline FAILED — the error rolled up to \"$PARENT\""
  echo "demo: inspect with: cat \${PROGRESS_STATE_PATH:-$HOME/.opencode-progress-state.json}"
  exit 1
fi

"${EMIT[@]}" --id "$PARENT" --status done --detail "all subtasks green" "${STATE_ARGS[@]}"
echo "demo: pipeline done — \"$PARENT\" rolled up from its children"
echo "demo: inspect with: cat \${PROGRESS_STATE_PATH:-$HOME/.opencode-progress-state.json}"
