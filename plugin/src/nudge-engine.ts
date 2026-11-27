/**
 * Which nudge engine delivers built-in reminders.
 *
 * `shared` routes reminders through `@jakedowns/opencode-nudge` and is the
 * default. `legacy` keeps the plugin's in-process standing-reminder engine as
 * an explicit opt-in for setups where shared delivery misbehaves.
 *
 * The old `shadow` comparison mode was removed; unknown values fall back to
 * the default so an old config never silently disables nudges.
 */

export type NudgeEngine = "shared" | "legacy";

export function resolveNudgeEngine(value: unknown): NudgeEngine {
  return value === "legacy" ? "legacy" : "shared";
}
