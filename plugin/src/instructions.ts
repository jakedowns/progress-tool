/**
 * Progress & relay rules injected into every session's system instructions.
 *
 * These are the pre-emptive counterpart to the relay hint the `progress` tool
 * returns with every `running` response (see `docs/out-of-band-relay-spec.md`
 * §5.3 and §7.4): the hint teaches the relay AFTER the agent calls the tool;
 * this text makes sure the agent already knows about it BEFORE its first
 * long-running command.
 */

import type { SayOptions } from "./say.js";

export const PROGRESS_RULES = `Progress reporting rules (progress-server MCP tool + progress-relay). This tool is DUAL PURPOSE:
(1) A drop-in replacement for the todo/task-tracking tools you might instinctively reach for (todowrite / TaskCreate): task state belongs here, where it also drives the live indicator.
(2) A wrapper for long-running programmatic tool calls (build scripts, compilers, test suites, installs — anything that reports progress on stdout) via the out-of-band relay.
- Report ANY multi-step or long-horizon work with the fire-and-forget progress tool — not just shell commands: research, planning, codebase exploration, multi-file refactors, documentation writing — anything expected to run longer than a couple of minutes or a single reply. Call it once at the start (status "running", a clean stable id, parentId for phases like plan → implement → verify), then KEEP IT CURRENT WHILE YOU WORK: non-shell work has no relay, so spend one of your turns between tool calls — roughly every few calls, or whenever you start or finish a step — on a progress update (fresh detail, a status change, or — for build-like work only — a progress 0.0–1.0 fraction). Fractions are optional: never invent a percentage for authoring, research, or review; status plus detail is complete. That between-turn cadence is the todowrite-style data plane that keeps the summary rollup live. Close with "done" or "error" when the work finishes or fails. Keep titles short; put multi-line context in detail. For multi-step plans, make one child entry per step (parentId = the parent task) — never a numbered list inside one title/detail — so each step gets its own status/progress in the rollup.
- RE-ARM AND REtro-count: when your current progress tree is "done" and you begin new multi-edit work, open a FRESH tree — do not keep working entry-less. And if you find you have ALREADY made 2+ consecutive edits or shell calls on one task with no active progress entry, that is multi-step work by definition: start a tree now (it is never too late — record what is done, what remains).
- Steering is work: when the user redirects you mid-flight while a tree is in progress, record the steer as a child entry — one line summarizing the ask plus what you plan to do in reaction — and update it as you respond. The user should see their steer land in the rollup.
- Delegate independent work: subagents run in parallel with fresh context — use explore for read-only searches and general for multi-step work, and omit model so they inherit this session's model. Mirror each workstream as a child progress entry and wait for the completion report instead of polling. Subagents file progress under the session named in their prompt (see the progress-session block below), so their work rolls up under yours instead of becoming orphaned.
- Why this tool exists: the transcript — thought traces, tool calls, command output — is a wall of text. The tree is the glance-able layer above it: a live, high-level view of what you are doing, what you are waiting on, and what is next. Keep it accurate at that level. A short headline title, the current step in detail, and an honest progress fraction when one is meaningful — so the user can read the pill instead of scrolling the log.
- For long-running shell commands (compilers, test suites, installs, downloads, docker builds, full lint runs), call progress with status "running" first, then run the command THROUGH the out-of-band relay instead of waiting on it: progress-relay --id <id> -- <cmd>  (or pipe: <cmd> | progress-relay --id <id>). Use the exact relay command printed in the progress tool response. When the harness supports background commands, run the wrapped command in the background and keep working; the completion notification is your cue for the final milestone.
- NEVER poll for shell telemetry: no sleep loops, no re-calling progress on a timer for elapsed time or percentages, no reading terminal output in a loop. The relay streams throttled telemetry (latest output line, "45%") into the indicator at zero token cost, and its exit code maps automatically to done/error — do not re-call progress with "done" unless adding semantic detail. (Between-turn updates during non-shell work are the intended cadence, not polling.)
- Long single-step work: use \`progress_touch\` (\`{ id, detail? }\`) to refresh an existing entry without inventing a progress fraction. Batch writes: use ONE \`progress\` call per execute and pass \`entries[]\`; several separate MCP calls in one execute can hit host permission prompts.
- If progress-relay is unavailable, report start/done/error boundaries only; the UI derives elapsed time from startedAt.`;

/** Resolve whether rule injection is enabled (default: true). */
export function instructionsEnabled(raw: unknown): boolean {
  const options = (raw ?? {}) as Record<string, unknown>;
  return options.injectInstructions !== false;
}

/**
 * Per-session attribution block.
 *
 * The desktop pill only shows the session the user is looking at, so a
 * subagent that reports under its own child session is invisible. This block
 * gives the agent two handles it otherwise lacks: its own session id (to hand
 * to children) and the precedence rule (a prompt-supplied id wins), which is
 * the instruction-side fallback for the plugin's automatic child→parent map.
 */
export function sessionAttributionRules(sessionID: string): string {
  return `Progress session attribution:
- This conversation's progress session is \`${sessionID}\`. Keep the id out of user-facing prose.
- When you launch a subagent, include this line in its task prompt: \`progress sessionId: ${sessionID}\`, and tell it to pass \`sessionId: "${sessionID}"\` on every \`progress\` call and \`--session ${sessionID}\` on every \`progress-relay\` command.
- If your task prompt contains a \`progress sessionId\`, that value wins over the id above: use it for all progress and relay calls so your work rolls up under the parent session instead of an orphaned child session.`;
}

/**
 * `say` narration rules, injected only when the experimental tool is enabled.
 *
 * This is the part that asks for the shallow reply: one short note before the
 * first tool of a multi-step task, so the user is not left watching a spinner
 * or digging through the thought trace while tools run in the background.
 */
export function sayRules(options: SayOptions, toolName = "say"): string {
  return `Narration (\`${toolName}\` tool, opt-in). Before you start a multi-step task, or any tool call likely to run longer than ~30 seconds, call \`${toolName}\` once: give a ${options.minChars}–${options.maxChars} character summary of what you're about to embark on and a rough ETA. The user should never be left wondering what you're doing, or forced to dig through your thought trace while tools run in the background.
- Pair \`${toolName}\` with your first real tool call in the same assistant message (parallel tool calls) so it costs no extra round trip.
- \`${toolName}\` does **not** end the turn. It is not the final answer; never use it to deliver conclusions.
- Do not narrate trivial single-step actions; there is no per-turn note cap.
- \`progress\` is task state; \`${toolName}\` is narration. Do not duplicate the same sentence in both.`;
}
