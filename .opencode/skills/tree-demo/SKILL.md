---
name: Task Tree Demo
description: Demo nested task trees (parentId roll-up) in progress-tool — run a fake release pipeline with parent, child, and grandchild tasks streaming through the out-of-band relay at zero agent tokens, with an optional failure mode that rolls an error up the tree
---

# Task tree demo

Run the demo and explain what the viewer sees:

1. Optionally, start the GUI first in a second terminal: `./launch-gui.sh` (from
   the repository root — this skill lives in `<repo>/.opencode/skills/tree-demo/`,
   so the repo root is two levels up).
2. Run the happy path: `bash demo/tree-demo.sh` (works from any directory; set
   `PROGRESS_STATE_PATH` to isolate the state file if needed).
3. Run the failure mode: `PROGRESS_TREE_DEMO_FAIL=1 bash demo/tree-demo.sh` —
   `test-e2e` fails and the error rolls up through its parent to `tree-demo`.
4. Explain the mechanics: child tasks are real background commands wrapped in
   `progress-relay` (exit code → done/error, output → detail/percent at zero
   token cost); the parent is created once with `parentId`-linked children and
   its status/progress are a read-time roll-up (error beats running beats
   waiting; parent progress = mean of child progress), per
   `docs/out-of-band-relay-spec.md` §5.6.
5. Never poll or sleep to refresh the indicator — the tree converges on its own.

For OSC 9;4 structured progress (orthogonal feature), see the `osc-demo` skill.
