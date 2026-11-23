/**
 * Opt-in "long-tool" nudge for the experimental `say` tool.
 *
 * `say` is narration the agent chooses to post. We deliberately do NOT ship a
 * strict-mode clone: a context nudge injected while a tool is running cannot be
 * read until that tool returns, so the only useful trigger is *after* a tool
 * finishes (`execute.after`). The note is therefore retrospective and
 * habit-forming, never a synthetic message: the caller injects it as a context
 * entry on the next step.
 *
 * Guards, in evaluation order: mode off -> a say was already accepted this turn
 * -> the say budget is exhausted -> the call was short -> cooldown -> per-turn
 * cap -> a progress nudge already stands -> accept.
 *
 * Everything here is pure: no fs, no OpenCode imports, no side effects, so the
 * decision is unit-testable without a server.
 */

export type SayNudgeMode = "off" | "long-tool";

export interface SayNudgeOptions {
  mode: SayNudgeMode;
  afterMs: number;
  cooldownMs: number;
  maxPerTurn: number;
}

export interface SayNudgeState {
  /** Epoch ms of the last accepted nudge; 0 means "never". */
  lastNudgeAt: number;
  /** Accepted nudges in the current turn; reset by passing a fresh state. */
  nudgesThisTurn: number;
}

export interface SayNudgeInput {
  sessionID: string;
  tool: string;
  durationMs: number;
  saidThisTurn: boolean;
  sayCount: number;
  sayBudget: number;
  progressNudgeActive: boolean;
  now: number;
}

export type SayNudgeReason =
  | "off"
  | "said"
  | "budget"
  | "short"
  | "cooldown"
  | "cap"
  | "progress-nudge"
  | "accept";

export interface SayNudgeDecision {
  nudge: boolean;
  reason: SayNudgeReason;
  message?: string;
}

const DEFAULT_MODE: SayNudgeMode = "off";
const DEFAULT_AFTER_MS = 20_000;
const DEFAULT_COOLDOWN_MS = 120_000;
const DEFAULT_MAX_PER_TURN = 1;

const MIN_AFTER_MS = 1_000;
const MAX_AFTER_MS = 600_000;
const MIN_COOLDOWN_MS = 0;
const MAX_COOLDOWN_MS = 3_600_000;
const MIN_MAX_PER_TURN = 1;
const MAX_MAX_PER_TURN = 3;

/** Tool names are echoed into a one-line note; keep them short and tidy. */
const MAX_TOOL_CHARS = 60;
const MAX_MESSAGE_CHARS = 260;

function integerInRange(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Per-session nudge counters. A caller resets the turn by replacing this with a
 * fresh state (or by calling this again), which zeroes `nudgesThisTurn` while
 * keeping the cooldown clock on the per-session record if desired.
 */
export function emptySayNudgeState(): SayNudgeState {
  return { lastNudgeAt: 0, nudgesThisTurn: 0 };
}

/**
 * Read the flat plugin config. `sayNudge` is the config key; `true` is accepted
 * as shorthand for `"long-tool"` so the feature stays one flag to enable.
 * Anything unrecognized means off.
 */
export function normalizeSayNudgeOptions(raw: unknown): SayNudgeOptions {
  const options = (raw ?? {}) as Record<string, unknown>;
  const mode = options.sayNudge ?? options.mode;
  return {
    mode: mode === "long-tool" || mode === true ? "long-tool" : DEFAULT_MODE,
    afterMs: integerInRange(options.sayNudgeAfterMs, DEFAULT_AFTER_MS, MIN_AFTER_MS, MAX_AFTER_MS),
    cooldownMs: integerInRange(
      options.sayNudgeCooldownMs,
      DEFAULT_COOLDOWN_MS,
      MIN_COOLDOWN_MS,
      MAX_COOLDOWN_MS
    ),
    maxPerTurn: integerInRange(
      options.sayNudgeMaxPerTurn,
      DEFAULT_MAX_PER_TURN,
      MIN_MAX_PER_TURN,
      MAX_MAX_PER_TURN
    ),
  };
}

/** Seconds as a compact string: `21`, or `20.5` for sub-second precision. */
function formatSeconds(durationMs: number): string {
  const clamped = Math.max(0, durationMs);
  return String(Math.round(clamped / 100) / 10);
}

export function sayNudgeMessage(tool: string, durationMs: number): string {
  const name = String(tool ?? "").replace(/\s+/g, " ").trim() || "tool";
  const shortName =
    name.length > MAX_TOOL_CHARS ? `${name.slice(0, MAX_TOOL_CHARS - 1).trimEnd()}…` : name;
  const seconds = formatSeconds(durationMs);
  const message =
    `That ${shortName} call ran ${seconds}s with no narration this turn. ` +
    `Before the next long-running step, post a say with what it is doing and a rough ETA.`;
  return message.length > MAX_MESSAGE_CHARS
    ? `${message.slice(0, MAX_MESSAGE_CHARS - 1).trimEnd()}…`
    : message;
}

/**
 * Decide whether to nudge after a tool call finished. Pure: the caller owns the
 * per-session state and persists it with `recordSayNudge` on accept.
 *
 * Order: off -> said -> budget -> short -> cooldown -> cap -> progress-nudge -> accept.
 */
export function decideSayNudge(
  state: SayNudgeState,
  input: SayNudgeInput,
  options: SayNudgeOptions
): SayNudgeDecision {
  if (options.mode === "off") return { nudge: false, reason: "off" };
  if (input.saidThisTurn) return { nudge: false, reason: "said" };
  if (input.sayCount >= input.sayBudget) return { nudge: false, reason: "budget" };
  if (input.durationMs < options.afterMs) return { nudge: false, reason: "short" };
  // `lastNudgeAt === 0` means "never nudged", so the clock starts at the first
  // accepted nudge rather than blocking a fresh session on a fake boot time.
  if (state.lastNudgeAt > 0 && input.now - state.lastNudgeAt < options.cooldownMs) {
    return { nudge: false, reason: "cooldown" };
  }
  if (state.nudgesThisTurn >= options.maxPerTurn) return { nudge: false, reason: "cap" };
  if (input.progressNudgeActive) return { nudge: false, reason: "progress-nudge" };

  return {
    nudge: true,
    reason: "accept",
    message: sayNudgeMessage(input.tool, input.durationMs),
  };
}

/** Record an accepted nudge. Returns a new state; never mutates the argument. */
export function recordSayNudge(state: SayNudgeState, now: number): SayNudgeState {
  return {
    lastNudgeAt: now,
    nudgesThisTurn: state.nudgesThisTurn + 1,
  };
}
