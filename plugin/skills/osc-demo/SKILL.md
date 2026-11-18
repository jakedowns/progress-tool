---
name: OSC 9;4 Demo
description: Demo OSC 9;4 terminal progress support in progress-tool — run a fake build that streams native OSC 9;4 progress sequences through the out-of-band relay (progress-relay), zero agent tokens
---

# OSC 9;4 demo

Run the demo and explain what the viewer sees:

1. Optionally, start the GUI first in a second terminal: `./launch-gui.sh` (from
   the progress-tool repository root — clone it to run the demos; this skill
   ships both in-repo and packaged with the plugin).
2. Run the demo: `bash demo/osc-demo.sh` (also works from any directory; set
   `PROGRESS_STATE_PATH` to isolate the state file if needed).
3. Report the outcome: the fake build emits `OSC 9;4` sequences
   (`ESC ] 9;4;<state>;<progress> BEL`), the relay parses them before text
   heuristics (state 1 → percent, state 3 → indeterminate, state 4 → waiting),
   writes throttled telemetry to the shared state file at zero token cost, and
   maps the exit code to `done`/`error`. The task `osc-demo` ends done at 100%.
4. Never poll or sleep to refresh the indicator — that is the whole point of
   the out-of-band relay.

For the full contract, see `docs/out-of-band-relay-spec.md` §6.3.1. For the
corresponding test coverage, see the "OSC 9;4" tests in
`mcp-server/test/smoke.test.js` (`cd mcp-server && npm test`).
