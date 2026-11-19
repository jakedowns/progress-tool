/**
 * Progress & relay rules injected into every session's system instructions.
 *
 * These are the pre-emptive counterpart to the relay hint the `progress` tool
 * returns with every `running` response (see `docs/out-of-band-relay-spec.md`
 * §5.3 and §7.4): the hint teaches the relay AFTER the agent calls the tool;
 * this text makes sure the agent already knows about it BEFORE its first
 * long-running command.
 */

export const PROGRESS_RULES = `Progress reporting rules (progress-server MCP tool + progress-relay). This tool is DUAL PURPOSE:
(1) A drop-in replacement for the todo/task-tracking tools you might instinctively reach for (todowrite / TaskCreate): task state belongs here, where it also drives the live indicator.
(2) A wrapper for long-running programmatic tool calls (build scripts, compilers, test suites, installs — anything that reports progress on stdout) via the out-of-band relay.
- Report ANY multi-step or long-horizon work with the fire-and-forget progress tool — not just shell commands: research, planning, codebase exploration, multi-file refactors, documentation writing — anything expected to run longer than a couple of minutes or a single reply. Call it once at the start (status "running", a clean stable id, parentId for phases like plan → implement → verify), then KEEP IT CURRENT WHILE YOU WORK: non-shell work has no relay, so spend one of your turns between tool calls — roughly every few calls, or whenever you start or finish a step — on a progress update (fresh detail, a progress 0.0–1.0 fraction, or a status change). That between-turn cadence is the todowrite-style data plane that keeps the summary rollup live. Close with "done" or "error" when the work finishes or fails. Keep titles short; put multi-line context in detail. For multi-step plans, make one child entry per step (parentId = the parent task) — never a numbered list inside one title/detail — so each step gets its own status/progress in the rollup.
- RE-ARM AND REtro-count: when your current progress tree is "done" and you begin new multi-edit work, open a FRESH tree — do not keep working entry-less. And if you find you have ALREADY made 2+ consecutive edits or shell calls on one task with no active progress entry, that is multi-step work by definition: start a tree now (it is never too late — record what is done, what remains).
- Steering is work: when the user redirects you mid-flight while a tree is in progress, record the steer as a child entry — one line summarizing the ask plus what you plan to do in reaction — and update it as you respond. The user should see their steer land in the rollup.
- Delegate independent work: subagents run in parallel with fresh context — use explore for read-only searches and general for multi-step work, and omit model so they inherit this session's model. Mirror each workstream as a child progress entry and wait for the completion report instead of polling.
- Why this tool exists: the transcript — thought traces, tool calls, command output — is a wall of text. The tree is the glance-able layer above it: a live, high-level view of what you are doing, what you are waiting on, and what is next. Keep it accurate at that level. A short headline title, the current step in detail, an honest progress fraction — so the user can read the pill instead of scrolling the log.
- For long-running shell commands (compilers, test suites, installs, downloads, docker builds, full lint runs), call progress with status "running" first, then run the command THROUGH the out-of-band relay instead of waiting on it: progress-relay --id <id> -- <cmd>  (or pipe: <cmd> | progress-relay --id <id>). Use the exact relay command printed in the progress tool response. When the harness supports background commands, run the wrapped command in the background and keep working; the completion notification is your cue for the final milestone.
- NEVER poll for shell telemetry: no sleep loops, no re-calling progress on a timer for elapsed time or percentages, no reading terminal output in a loop. The relay streams throttled telemetry (latest output line, "45%") into the indicator at zero token cost, and its exit code maps automatically to done/error — do not re-call progress with "done" unless adding semantic detail. (Between-turn updates during non-shell work are the intended cadence, not polling.)
- If progress-relay is unavailable, report start/done/error boundaries only; the UI derives elapsed time from startedAt.`;

/** Resolve whether rule injection is enabled (default: true). */
export function instructionsEnabled(raw: unknown): boolean {
  const options = (raw ?? {}) as Record<string, unknown>;
  return options.injectInstructions !== false;
}
