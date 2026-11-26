/**
 * Opt-in nudges for the experimental `say` tool.
 *
 * Two detection paths, both evaluated *after* a tool finishes
 * (`execute.after`): a context nudge injected while a tool is running cannot
 * be read until that tool returns, so every note is retrospective and
 * habit-forming, never a synthetic message.
 *
 * 1. LONG TOOL — one call ran longer than `afterMs` with no accepted say this
 *    turn. Asks for narration before the next long step.
 * 2. SILENT RUN — `minCalls` tool calls in a row this turn with no accepted
 *    say, mirroring the progress monitor's forgot-to-update nudge. Catches
 *    agents that stay quiet across many quick calls.
 *
 * `both` fires on either path. The caller must also require the `say` tool
 * itself to be enabled: these nudges never exist for a disabled say.
 *
 * Guards, in evaluation order: mode off -> a say was already accepted this turn
 * -> the say budget is exhausted -> the mode's trigger has not been reached ->
 * cooldown -> per-turn cap -> a progress nudge already stands -> accept.
 *
 * Everything here is pure: no fs, no OpenCode imports, no side effects, so the
 * decision is unit-testable without a server.
 */

export type SayNudgeMode = "off" | "long-tool" | "silent-run" | "both";

export interface SayNudgeOptions {
  mode: SayNudgeMode;
  afterMs: number;
  /** Consecutive tool calls with no accepted say before a silent-run nudge. */
  minCalls: number;
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
  /** Non-say/progress tool calls this turn since the last accepted note. */
  callsSinceSay: number;
  saidThisTurn: boolean;
  progressNudgeActive: boolean;
  now: number;
}

export type SayNudgeReason =
  | "off"
  | "said"
  | "short"
  | "few-calls"
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
const DEFAULT_MIN_CALLS = 3;
const DEFAULT_COOLDOWN_MS = 120_000;
const DEFAULT_MAX_PER_TURN = 1;

const MIN_AFTER_MS = 1_000;
const MAX_AFTER_MS = 600_000;
const MIN_MIN_CALLS = 1;
const MAX_MIN_CALLS = 50;
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
 * as shorthand for `"long-tool"` (the backwards-compatible behavior). Accepts
 * `"long-tool"`, `"silent-run"`, or `"both"`. Anything unrecognized means off.
 */
export function normalizeSayNudgeOptions(raw: unknown): SayNudgeOptions {
  const options = (raw ?? {}) as Record<string, unknown>;
  const mode = options.sayNudge ?? options.mode;
  const normalizedMode: SayNudgeMode =
    mode === true || mode === "long-tool"
      ? "long-tool"
      : mode === "silent-run" || mode === "both"
        ? mode
        : DEFAULT_MODE;
  return {
    mode: normalizedMode,
    afterMs: integerInRange(options.sayNudgeAfterMs, DEFAULT_AFTER_MS, MIN_AFTER_MS, MAX_AFTER_MS),
    minCalls: integerInRange(
      options.sayNudgeMinCalls,
      DEFAULT_MIN_CALLS,
      MIN_MIN_CALLS,
      MAX_MIN_CALLS
    ),
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

function shortToolName(tool: string): string {
  const name = String(tool ?? "").replace(/\s+/g, " ").trim() || "tool";
  return name.length > MAX_TOOL_CHARS ? `${name.slice(0, MAX_TOOL_CHARS - 1).trimEnd()}…` : name;
}

function truncateMessage(message: string): string {
  return message.length > MAX_MESSAGE_CHARS
    ? `${message.slice(0, MAX_MESSAGE_CHARS - 1).trimEnd()}…`
    : message;
}

export function sayNudgeMessage(tool: string, durationMs: number): string {
  const seconds = formatSeconds(durationMs);
  return truncateMessage(
    `That ${shortToolName(tool)} call ran ${seconds}s with no narration this turn. ` +
      `Before the next long-running step, post a say with what it is doing and a rough ETA.`
  );
}

export function saySilentRunNudgeMessage(calls: number): string {
  const count = Math.max(1, Math.floor(calls));
  return truncateMessage(
    `That was tool call ${count} in a row this turn with no say note. ` +
      `Before the next step, post a say with what you are doing and a rough ETA.`
  );
}

function sayBothNudgeMessage(tool: string, durationMs: number, calls: number): string {
  const seconds = formatSeconds(durationMs);
  const count = Math.max(1, Math.floor(calls));
  return truncateMessage(
    `That ${shortToolName(tool)} call ran ${seconds}s after ${count} tool calls with no say note this turn. ` +
      `Before the next step, post a say with what you are doing and a rough ETA.`
  );
}

function acceptMessage(input: SayNudgeInput, options: SayNudgeOptions): string {
  const longEnough = input.durationMs >= options.afterMs;
  const enoughCalls = input.callsSinceSay >= options.minCalls;
  if (options.mode === "silent-run") return saySilentRunNudgeMessage(input.callsSinceSay);
  if (options.mode === "long-tool") return sayNudgeMessage(input.tool, input.durationMs);
  if (longEnough && enoughCalls) {
    return sayBothNudgeMessage(input.tool, input.durationMs, input.callsSinceSay);
  }
  return enoughCalls
    ? saySilentRunNudgeMessage(input.callsSinceSay)
    : sayNudgeMessage(input.tool, input.durationMs);
}

/**
 * Decide whether to nudge after a tool call finished. Pure: the caller owns the
 * per-session state and persists it with `recordSayNudge` on accept.
 *
 * Order: off -> said -> trigger -> cooldown -> cap -> progress-nudge -> accept.
 */
export function decideSayNudge(
  state: SayNudgeState,
  input: SayNudgeInput,
  options: SayNudgeOptions
): SayNudgeDecision {
  if (options.mode === "off") return { nudge: false, reason: "off" };
  if (input.saidThisTurn) return { nudge: false, reason: "said" };

  const longEnough = input.durationMs >= options.afterMs;
  const enoughCalls = input.callsSinceSay >= options.minCalls;
  if (options.mode === "long-tool" && !longEnough) return { nudge: false, reason: "short" };
  if (options.mode === "silent-run" && !enoughCalls) {
    return { nudge: false, reason: "few-calls" };
  }
  if (options.mode === "both" && !longEnough && !enoughCalls) {
    // Prefer the silent-run reason: the call count is the "forgot to narrate"
    // signal this mode was added for, and the duration may be unmeasurable.
    return { nudge: false, reason: "few-calls" };
  }

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
    message: acceptMessage(input, options),
  };
}

/** Record an accepted nudge. Returns a new state; never mutates the argument. */
export function recordSayNudge(state: SayNudgeState, now: number): SayNudgeState {
  return {
    lastNudgeAt: now,
    nudgesThisTurn: state.nudgesThisTurn + 1,
  };
}
