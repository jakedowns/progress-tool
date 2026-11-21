/**
 * Subagent prompt attribution.
 *
 * The map recorded from `session.created` closes the gap once a child exists,
 * but a subagent's very first tool call can still beat that write. Stamping
 * the parent session id into the task prompt is the belt-and-suspenders
 * fallback: the child's injected rules treat a prompt-supplied
 * `progress sessionId` as authoritative.
 */

/** Tool ids that spawn a subagent; `task` is the older name. */
export const SUBAGENT_TOOLS = ["subagent", "task"] as const;

export function isSubagentTool(tool: string): boolean {
  return (SUBAGENT_TOOLS as readonly string[]).includes(tool);
}

/**
 * Append the parent session hand-off to a subagent tool input's `prompt`.
 * Mutates `input` (OpenCode hands hooks a mutable arguments object) and
 * returns whether anything changed. Idempotent: an already-stamped prompt is
 * left alone.
 */
export function injectParentSession(input: unknown, parentSessionID: string): boolean {
  if (!input || typeof input !== "object" || !parentSessionID) return false;
  const prompt = (input as { prompt?: unknown }).prompt;
  if (typeof prompt !== "string" || prompt.length === 0) return false;
  const line = `progress sessionId: ${parentSessionID}`;
  if (prompt.includes(line)) return false;
  (input as { prompt: string }).prompt =
    `${prompt}\n\n${line}\n` +
    `Pass \`sessionId: "${parentSessionID}"\` to the progress tool and ` +
    `\`--session ${parentSessionID}\` to progress-relay so your work ` +
    `rolls up under the parent session.`;
  return true;
}
