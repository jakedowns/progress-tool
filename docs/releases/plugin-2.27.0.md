# 2.27.0

**Full Changelog**: [plugin@2.23.0...plugin@2.27.0](https://github.com/jakedowns/progress-tool/compare/plugin%402.23.0...plugin%402.27.0)

This release covers 23 commits since the last published plugin release. Versions
2.24.0–2.26.0 were development checkpoints and are included here.

## Nudges and reminders

- Removed the `say` tool's per-turn note budget and cooldown. Notes are no
  longer count- or time-gated; consecutive identical text is still skipped.
- Added a native `progress` tool (`progress_write` when the MCP tool already
  owns the name) that writes the shared store without a Code-Mode MCP wrapper.
- Added automatic subagent nodes: `session.created` creates a running node per
  child session under the parent, and `session.deleted` closes it.
- Turn-end reminders now only count **owned** entries that are stale for
  `idleStaleMs` (default 10m) or errored within the last hour. Child-owned
  entries and parents blocked on children are excluded and reported separately.
- Wall-clock and strict stale reminders skip a parent while child sessions are
  actively running. Wall-clock default moved from 2m to 10m.
- Silent-run reminders now require the elapsed `staleAfterMs` window, so a
  quick burst of steps is not treated as a silent run.
- Strict/say reminders share one channel, a **2-per-session cap**, and a
  `nudgeGraceMs` quiet window (default 10m) after any real progress write.
- Fractional progress is optional everywhere. Missing progress renders no bar
  or `0%`, and guidance no longer asks for percentages on authoring work.
- Relay hints now key on the command shape and fire once, on the second
  occurrence. Heredoc and inline-script bodies are ignored.
- Added an always-available agent mute (`progress_nudge` / shared nudge flows):
  quiet non-block reminders for 1–240 minutes; block reminders still land.
- Added a global `nudgeGapMs` quiet period between non-block reminders.

## GUI and tree views

- Added the **ultra-compact** tree theme, now the default: one title line with
  status light, last-updated age, dismiss button, and no bar/percentage/detail.
- Hovering an ultra row reveals its description with a 0.3s height/fade; the
  title tooltip carries the full untruncated description.
- Ultra titles are 12px regular weight, with a fixed-width age column and 3px
  row spacing; the tree has a 5px outer margin.
- Added the **Progress: indicator style** command: flat CSS dots, emoji
  circles, or checkbox emoji. The choice persists as a global preference.
- Added the Settings tab in the pill popover and sidebar, showing effective
  view/reminder/data options. The footer version links to Releases.
- Added a countdown ring to note rows for auto-hide expiry.
- Expand/collapse now uses `[+]`/`[-]`, and leaf status indicators reserve the
  same width so rows align.
- Fixed the sidebar launcher registration so Progress appears in the New Tab
  page and `+` menu.
- Subagent prefixes now use `[subagent <session title>]` (20 chars max);
  the subagent type appears in the row hover tooltip.

## Maintenance

- Added a `-dev` suffix for untagged GUI builds, with `PROGRESS_DEV=0|1`
  overrides. Release builds stay clean automatically, and the release workflow
  fails if a `-dev` bundle is published.
- Added reminder-flow diagrams and cooldown/snooze reference documentation.
- Added shared-nudge migration plans, TODO tracking, and a synthetic-delivery
  experiment hypothesis.
- Test suite is now **234 plugin + 60 MCP tests**.

---

## Links

- **npm:** [@jakedowns/progress-tool-opencode-plugin@latest](https://www.npmjs.com/package/@jakedowns/progress-tool-opencode-plugin)
- Repository & full docs: [https://github.com/jakedowns/progress-tool](https://github.com/jakedowns/progress-tool)
- License: MIT

---

## 💛 Support

If this plugin saves you time, donations are greatly appreciated — they keep it maintained and improving:

- [GitHub Sponsors](https://github.com/sponsors/jakedowns)
- [Patreon](https://www.patreon.com/jakedowns)
- [Ko-fi](https://ko-fi.com/jakedowns)
- [Buy Me a Coffee](https://www.buymeacoffee.com/jakedowns)

**Feedback & issues:** found a bug, have an idea, or want a feature? Open an [issue](https://github.com/jakedowns/progress-tool/issues) — reports and suggestions are welcome.

**If you like it or find it useful, please ⭐ [star the repo](https://github.com/jakedowns/progress-tool) and share it on social media** — it's the easiest way to help more people discover it.
