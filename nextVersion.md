# Next version

Ideas and reminders that are **not yet implemented** (notes dated 2026-11-23).

## Tree updates must freeze over dismiss controls

- **Risk.** The GUI tree can refresh, insert, or reorder rows while the pointer
  is hovering a row's dismiss `✕`. If a new row lands under the pointer, the
  click dismisses the wrong task. This affects the composer pill
  popover/menu and the sidebar tree, plus the TUI mouse equivalent
  (`onDismiss` on tree rows in `plugin/src/tui.tsx`).
- **Desired behavior.** While the pointer is over a dismiss control — or a
  dismissal animation is still running — suspend tree refreshes and row
  insertion. Queue the latest state and apply it once the pointer leaves or
  the dismissal completes, keeping the same row identity under the pointer.
- **Implementation notes.** Reuse the existing GUI `interacting()` /
  `suspendUntil` refresh gating; add a dedicated hover guard around dismiss
  buttons; cover both `MenuRow` dismiss buttons and any host `rows` dismiss
  actions. Test with rapid state updates and compact tree mode.

## Configurable concise entry copy

- **Idea.** Add a configurable target for progress entry title/description
  length — e.g. a `treeCopyMode: "default" | "concise"` preset, with
  `titleChars` / `detailChars` knobs. The concise preset nudges agents toward
  **20–60 character** titles and one-line descriptions.
- **Scope.** Guidance only: injected progress rules, the `progress` tool
  description and hints, relay hints, and optional view-side caps. Do not
  silently truncate stored title/detail; remind or warn instead, matching
  `say`'s length-as-preference behavior.
- **Why.** Compact/barless tree rows read best with short copy. Current rules
  say "short" but give no measurable target, and the 20–80 `say` experiment is a
  useful precedent.
- **Open questions.** One target for both title and detail vs separate; global
  vs per-entry; palette-exposed or config-only; how to phrase the nudge without
  encouraging lost detail.

## Other candidates (brainstorming — not commitments)

- Revisit parent→child steer behavior.
- Toast reload keying.
- Consider whether compact tree mode needs its own refresh cadence.
