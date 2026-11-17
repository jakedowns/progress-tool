/**
 * Progress & relay rules injected into every session's system instructions.
 *
 * These are the pre-emptive counterpart to the relay hint the `progress` tool
 * returns with every `running` response (see `docs/out-of-band-relay-spec.md`
 * §5.3 and §7.4): the hint teaches the relay AFTER the agent calls the tool;
 * this text makes sure the agent already knows about it BEFORE its first
 * long-running command.
 */

export const PROGRESS_RULES = `Progress reporting rules (progress-server MCP tool + progress-relay):
- Report task state with the fire-and-forget progress tool: once at each phase start with status "running", a clean stable id (e.g. "build-1"), and optional parentId for subtasks; call again ONLY at real transitions ("waiting", "done", "error"). Keep titles short; put multi-line context in detail.
- For any long-running command (compilers, test suites, installs, downloads, docker builds, full lint runs), call progress with status "running" first, then run the command THROUGH the out-of-band relay instead of waiting on it: progress-relay --id <id> -- <cmd>  (or pipe: <cmd> | progress-relay --id <id>). Use the exact relay command printed in the progress tool response. When the harness supports background commands, run the wrapped command in the background and keep working; the completion notification is your cue for the final milestone.
- NEVER poll: no sleep loops, no re-calling progress on a timer for elapsed time or percentages, no reading terminal output in a loop. The relay streams throttled telemetry (latest output line, "45%") into the indicator at zero token cost, and its exit code maps automatically to done/error — do not re-call progress with "done" unless adding semantic detail.
- If progress-relay is unavailable, report start/done/error boundaries only; the UI derives elapsed time from startedAt.`;

/** Resolve whether rule injection is enabled (default: true). */
export function instructionsEnabled(raw: unknown): boolean {
  const options = (raw ?? {}) as Record<string, unknown>;
  return options.injectInstructions !== false;
}
