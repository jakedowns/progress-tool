/**
 * Strict-mode monitor: detect agents calling tools back-to-back without
 * updating progress, and decide whether/how to nudge.
 *
 * Two detection paths:
 *
 * 1. SILENT RUN — the session has no running/waiting entry at all and the
 *    agent keeps calling tools. At `threshold` consecutive silent calls:
 *    "you're working without a task entry — start one".
 *
 * 2. STALE PROGRESS — the session HAS pending tasks, the agent keeps calling
 *    tools, but no progress value has changed (across all roots and
 *    descendants) for `staleAfterMs`, AND at least `staleMinCalls` tool calls
 *    have happened since that last change. At most once per `cooldownMs`:
 *    "you have pending tasks and haven't changed their % recently — any
 *    updates?".
 *
 * Progress activity is measured from the store, not from the model's
 * self-reports: any progress write (tool call or relay tick) bumps an
 * entry's updatedAt, which resets the staleness clock, the
 * calls-since-progress counter, and the escalation ladder.
 *
 * Pure decision logic — no I/O — so it is unit-testable. The plugin server
 * part applies the decision: an instructions entry (visible to the model at
 * the next step boundary, without queuing a message turn) for "nudge" /
 * "stale-nudge", plus a synthetic message for "force" and "stale-escalate".
 *
 * Stale-progress reinforces itself: the first `staleEscalateAfter` reminders
 * (default 3) ride the standing context entry so a busy agent can finish its
 * step. If it still has not written progress, the next reminder escalates once
 * to a synthetic message, which cannot be mistaken for a discardable context
 * value. The ladder resets on any real progress write.
 */

import {
  formatAge,
  formatReminder,
  isHealthyWaiting,
  type NudgeTarget,
} from "./reminders.js";

export type StrictMode = "nudge" | "force" | "off";

export interface MonitorState {
  /** Consecutive tool calls with no active entry. */
  count: number;
  /** Tool calls since any progress value changed (tool write or relay tick). */
  callsSinceProgress: number;
  /** A silent-run nudge is currently standing (instructions entry present). */
  nudged: boolean;
  /** A forced synthetic reminder was already sent this non-compliance run. */
  forced: boolean;
  /** Epoch ms of the last stale-progress nudge (cooldown). */
  lastStaleNudgeAt: number;
  /** Stale-progress reminders sent in the current non-compliance stretch. */
  staleNudges: number;
  /** The synthetic escalation was already sent this non-compliance stretch. */
  escalated: boolean;
  /** Epoch ms the current standing nudge was written (compliance latency). */
  nudgedAt: number;
}

export type MonitorAction =
  | "none"
  | "nudge"
  | "force"
  | "clear"
  | "stale-nudge"
  | "stale-escalate";

export interface ObserveInput {
  /** The call was to the progress tool itself. */
  isProgressCall: boolean;
  /** The session currently has a running/waiting progress entry. */
  hasActive: boolean;
  /** Epoch ms of the last progress write across all roots + descendants. */
  lastProgressAt?: number;
  /** True when the store's newest update is newer than the last observed one. */
  progressAdvanced?: boolean;
  /** Epoch ms now. */
  now?: number;
  /**
   * Logical steps since the last progress write, when the caller counts model
   * steps. When omitted, the legacy per-tool-call count is used.
   */
  stepsSinceProgress?: number;
}

export interface ObserveOptions {
  threshold?: number;
  strictMode?: StrictMode;
  /** No progress write for this long with pending tasks ⇒ stale nudge. Default 5 min. */
  staleAfterMs?: number;
  /** Tool calls since the last progress write before a stale nudge. Default 3. */
  staleMinCalls?: number;
  /** Minimum gap between stale nudges. Default 2 min. */
  cooldownMs?: number;
  /**
   * Entry-based stale reminders allowed before one synthetic escalation.
   * Default 3 (escalate on the 4th stale nudge); 0 disables escalation.
   */
  staleEscalateAfter?: number;
}

export interface ObserveResult {
  action: MonitorAction;
  count: number;
  callsSinceProgress: number;
  lastStaleNudgeAt: number;
  staleNudges: number;
  escalated: boolean;
  nudgedAt: number;
}

export function normalizeStrictMode(raw: unknown): StrictMode {
  const value = (raw ?? {}) as Record<string, unknown>;
  if (value.strictMode === "force") return "force";
  if (value.strictMode === "off") return "off";
  return "nudge";
}

export function normalizeStaleAfterMs(raw: unknown, fallback = 5 * 60 * 1000): number {
  const value = (raw ?? {}) as Record<string, unknown>;
  const ms = value.staleAfterMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 30_000 ? ms : fallback;
}

/** Minimum gap between stale reminders. Default 2 min; values below 30s are ignored. */
export function normalizeStaleCooldownMs(raw: unknown, fallback = 2 * 60 * 1000): number {
  const value = (raw ?? {}) as Record<string, unknown>;
  const ms = value.cooldownMs;
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 30_000 ? ms : fallback;
}

/** `0` disables synthetic escalation; otherwise at least one entry nudge. */
export function normalizeStaleEscalateAfter(raw: unknown, fallback = 3): number {
  const value = (raw ?? {}) as Record<string, unknown>;
  const n = value.staleEscalateAfter;
  if (n === 0) return 0;
  if (typeof n === "number" && Number.isFinite(n) && n >= 1) {
    return Math.min(50, Math.floor(n));
  }
  return fallback;
}

/**
 * Decide the response to one observed tool call.
 *
 * Precedence: a progress call always clears a standing nudge and resets all
 * counters. With pending tasks, stale-progress detection applies; without
 * them, silent-run detection applies.
 */
export function observeToolCall(
  monitor: MonitorState,
  input: ObserveInput,
  options: ObserveOptions = {}
): ObserveResult {
  const threshold = options.threshold ?? 3;
  const strictMode = options.strictMode ?? 'nudge';
  const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
  const staleMinCalls = options.staleMinCalls ?? 3;
  const cooldownMs = options.cooldownMs ?? 2 * 60 * 1000;
  const staleEscalateAfter = options.staleEscalateAfter ?? 3;

  if (strictMode === 'off') {
    return {
      action: 'none',
      count: 0,
      callsSinceProgress: 0,
      lastStaleNudgeAt: monitor.lastStaleNudgeAt,
      staleNudges: 0,
      escalated: false,
      nudgedAt: 0,
    };
  }

  if (input.isProgressCall) {
    return {
      action: monitor.nudged ? 'clear' : 'none',
      count: 0,
      callsSinceProgress: 0,
      lastStaleNudgeAt: monitor.lastStaleNudgeAt,
      staleNudges: 0,
      escalated: false,
      nudgedAt: 0,
    };
  }

  // A relay tick (or any write since the last observation) is progress
  // activity: reset the staleness clock, the counter, and the escalation
  // ladder.
  const progressed = input.progressAdvanced === true;
  const stepCount = input.stepsSinceProgress;
  const callsSinceProgress = progressed
    ? 0
    : stepCount != null
      ? Math.max(0, Math.floor(stepCount))
      : monitor.callsSinceProgress + 1;
  const now = input.now ?? Date.now();
  const lastProgressAt = input.lastProgressAt ?? now;
  const staleNudges = progressed ? 0 : monitor.staleNudges ?? 0;
  const escalated = progressed ? false : monitor.escalated ?? false;
  const nudgedAt = progressed ? 0 : monitor.nudgedAt ?? 0;

  const untouched: ObserveResult = {
    action: 'none',
    count: monitor.count,
    callsSinceProgress,
    lastStaleNudgeAt: monitor.lastStaleNudgeAt,
    staleNudges,
    escalated,
    nudgedAt,
  };

  if (input.hasActive) {
    // Compliant on the "has a task" axis. A standing nudge entry clears only
    // when actual progress happened (a progress call or a store write) —
    // otherwise a stale-progress reminder would be wiped by the very next
    // tool call before the agent acted on it.
    const clearAction: MonitorAction = monitor.nudged && progressed ? 'clear' : 'none';
    const age = now - lastProgressAt;
    if (
      age >= staleAfterMs &&
      callsSinceProgress >= staleMinCalls &&
      now - monitor.lastStaleNudgeAt >= cooldownMs
    ) {
      const nextStale = staleNudges + 1;
      // The first few reminders are soft (context entry). If the agent still
      // has not written progress, escalate ONE synthetic message so the
      // instruction is a real turn input instead of a mutable context value.
      const shouldEscalate =
        staleEscalateAfter > 0 && nextStale > staleEscalateAfter && !escalated;
      return {
        action: shouldEscalate ? 'stale-escalate' : 'stale-nudge',
        count: 0,
        callsSinceProgress,
        lastStaleNudgeAt: now,
        staleNudges: nextStale,
        escalated: escalated || shouldEscalate,
        nudgedAt: now,
      };
    }
    return {
      ...untouched,
      action: clearAction,
      count: 0,
      callsSinceProgress,
      nudgedAt: progressed ? 0 : nudgedAt,
    };
  }

  const count = stepCount != null ? Math.max(0, Math.floor(stepCount)) : monitor.count + 1;
  // Silent-run nudges also need elapsed time: a short burst of steps inside a
  // few seconds is one atomic action, not a silent run.
  if (now - lastProgressAt < staleAfterMs) {
    return { ...untouched, action: 'none', count, callsSinceProgress };
  }
  if (count >= threshold && !monitor.nudged) {
    if (strictMode === 'force' && !monitor.forced) {
      return {
        action: 'force',
        count,
        callsSinceProgress,
        lastStaleNudgeAt: monitor.lastStaleNudgeAt,
        staleNudges,
        escalated,
        nudgedAt: now,
      };
    }
    return {
      action: 'nudge',
      count,
      callsSinceProgress,
      lastStaleNudgeAt: monitor.lastStaleNudgeAt,
      staleNudges,
      escalated,
      nudgedAt: now,
    };
  }
  return { ...untouched, action: 'none', count, callsSinceProgress };
}

/**
 * The standing instructions-entry nudge text (silent run).
 *
 * Self-identifies as authoritative because the harness renders entry updates
 * behind a "context changed and supersedes the previous value" preamble. The
 * payload must still read as a directive if the model skims that wrapper.
 */
function targetSuffix(target?: NudgeTarget): string {
  return target ? ` (${target.id} ${target.status} ${formatAge(target.ageMs)})` : "";
}

export function silentRunNudge(
  count: number,
  target?: NudgeTarget,
  severity: "info" | "warn" | "block" = "warn"
): string {
  return formatReminder(
    severity,
    `${count} step${count === 1 ? "" : "s"} with no progress entry${targetSuffix(target)}. Next: start or update the tree.`
  );
}

/** The stale-progress nudge text (pending tasks, unchanged %). */
export function staleProgressNudge(callsSinceProgress: number, target?: NudgeTarget): string {
  return formatReminder(
    "warn",
    `${callsSinceProgress} step${callsSinceProgress === 1 ? "" : "s"} without a progress change${targetSuffix(target)}. Next: update detail/progress or close it.`
  );
}

/**
 * Escalated stale-progress message: sent as a synthetic turn input, not a
 * context entry, after the entry-based reminders were ignored.
 */
export function staleProgressEscalation(
  callsSinceProgress: number,
  staleNudges: number,
  target?: NudgeTarget
): string {
  return formatReminder(
    "block",
    `progress reminder #${staleNudges}: tree unchanged after ${callsSinceProgress} steps${targetSuffix(target)}. Update or close it now.`
  );
}

// --- Relay hint (pre-flight, before the command runs) ---------------------

const LONG_COMMAND_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:build|test|lint|check|typecheck))\b|\b(?:vite\s+build|webpack|rollup|jest|vitest|pytest|cargo\s+(?:build|test)|go\s+(?:build|test)|make\b|gradlew?(?:\.bat)?|mvnw?|docker\s+build)\b/i;

/**
 * Detect a long-running command that is NOT already piped through the relay.
 * Returns the command when a hint should be shown, otherwise null. Detection
 * only — the plugin never rewrites the command.
 */
export function relayHintFor(command: string | null | undefined): string | null {
  if (!command || typeof command !== "string") return null;
  // Already relayed: the bin/alias, or the bundled invocation path.
  if (/progress-relay|progress-emit|index\.js\s+relay\b/.test(command)) return null;
  // Git operations are fast; their commit messages often mention test/build
  // commands in prose, which must not trigger a relay hint.
  if (/^\s*git\b/.test(command)) return null;
  // Heredocs and inline scripts often *contain* long commands as text. The
  // script itself is not the command to relay.
  if (/<<-?\s*['"]?[A-Za-z_]/.test(command)) return null;
  if (/^\s*(?:python3?|node|ruby|perl)\s+-(?:c|e)\b/.test(command)) return null;
  if (!LONG_COMMAND_RE.test(command)) return null;
  return command.trim();
}

/**
 * Stable key for a repeating long-command shape. Strips leading environment
 * assignments and `cd … &&` wrappers, then keeps the executable basename and
 * its first non-flag argument. Two `./gradlew assembleDebug` runs share a key.
 */
export function relayCommandPattern(command: string | null | undefined): string | null {
  const hinted = relayHintFor(command);
  if (!hinted) return null;
  let rest = hinted
    .replace(/^(?:export\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)+/, "")
    .replace(/^cd\s+[^&]+\s*&&\s*/, "")
    .trim();
  const tokens = rest.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const executable = tokens[0].replace(/^['"]|['"]$/g, "").split("/").pop() || tokens[0];
  const subcommand = tokens[1] && !tokens[1].startsWith("-") ? tokens[1] : "";
  return `${executable}${subcommand ? ` ${subcommand}` : ""}`.slice(0, 80);
}

export function relayPatternHintMessage(
  pattern: string,
  count: number,
  command: string
): string {
  const shown = command.length > 80 ? `${command.slice(0, 77)}…` : command;
  return `Repeating long command (${count}×): ${pattern}. Next time wrap it: progress-relay --id <id> -- ${shown} (or pipe it).`;
}

export function relayHintMessage(command: string): string {
  const shown = command.length > 90 ? `${command.slice(0, 87)}…` : command;
  return `Long command — next time wrap it: progress-relay --id <id> -- ${shown} (or pipe it). Exit code maps to done/error.`;
}

// --- Idle reminder (turn-end nudge) --------------------------------------

export interface IdleEntry {
  id: string;
  title?: string;
  status: string;
  detail?: string | null;
  parentId?: string | null;
  dismissed?: { at: number } | null;
  /** Written by a child/subagent session and adopted onto this one. */
  subagent?: boolean;
  /** Epoch ms of the entry's last write; relay ticks keep this fresh. */
  updatedAt?: number;
}

export interface IdleTracker {
  /** Sorted signature of the open entries at the last reminder. */
  signature: string;
  /** Epoch ms of the last reminder. */
  lastAt: number;
  /** Reminders sent for the current (unchanged) signature. */
  count: number;
}

export interface IdleDecision {
  action: "remind" | "none";
  signature: string;
  lastAt: number;
  count: number;
  message?: string;
}

/**
 * Decide whether to remind the model on session idle (turn end).
 *
 * Fires when the session is about to go idle with open (running/waiting,
 * non-dismissed) entries. Guardrails against loops — the synthetic message
 * runs in the same execution, so an agent that ignores it would otherwise
 * idle again immediately:
 * - Same signature re-idles are suppressed until `cooldownMs` and capped at
 *   `maxPerRun` reminders; a changed signature resets the count.
 */
export function idleReminder(
  tracker: IdleTracker,
  entries: readonly IdleEntry[],
  options: { cooldownMs?: number; maxPerRun?: number; now?: number; staleAfterMs?: number } = {}
): IdleDecision {
  const cooldownMs = options.cooldownMs ?? 120_000;
  const maxPerRun = options.maxPerRun ?? 3;
  const now = options.now ?? Date.now();
  // A turn-end reminder should only fire for work the session itself has
  // neglected. Relay-driven tasks tick several times per second, so only
  // entries nobody is writing to deserve it; 10 minutes is longer than a
  // build-and-device pass and avoids nagging healthy long work.
  const staleAfterMs = options.staleAfterMs ?? 10 * 60_000;

  const nonTerminal = entries.filter(
    (entry) =>
      entry &&
      !entry.dismissed &&
      (entry.status === "running" ||
        entry.status === "waiting" ||
        entry.status === "pending" ||
        entry.status === "error")
  );
  // A parent whose child entry is still open is blocked on that child, not
  // abandoned. Do not count it as neglect.
  const blockedParents = new Set(
    nonTerminal
      .map((entry) => entry.parentId)
      .filter((id): id is string => typeof id === "string" && id.length > 0)
  );
  const childOwned = nonTerminal.filter((entry) => entry.subagent).length;

  const neglected = nonTerminal
    .filter((entry) => !entry.subagent)
    .filter((entry) => !(entry.id && blockedParents.has(entry.id)))
    .filter((entry) => {
      // An old terminal error is history, not a task the agent can close.
      // Only surface errors that are recent enough to act on.
      if (entry.status === "error") {
        return entry.updatedAt == null || now - entry.updatedAt <= 60 * 60_000;
      }
      if (isHealthyWaiting(entry, now, staleAfterMs)) return false;
      return entry.updatedAt == null || now - entry.updatedAt >= staleAfterMs;
    })
    .map((entry) => {
      const age = entry.updatedAt == null ? "unknown" : formatAge(now - entry.updatedAt);
      return `${entry.id} (${entry.status}, ${age})`;
    })
    .sort();
  const signature = neglected.join(" | ");

  if (neglected.length === 0) {
    return { action: "none", signature, lastAt: tracker.lastAt, count: 0 };
  }

  const changed = signature !== tracker.signature;
  const count = changed ? 0 : tracker.count;
  if (!changed && (count >= maxPerRun || now - tracker.lastAt < cooldownMs)) {
    return { action: "none", signature, lastAt: tracker.lastAt, count };
  }

  const shown = neglected.slice(0, 3).join(", ");
  const suffix = neglected.length > 3 ? ` +${neglected.length - 3} more` : "";
  const excluded: string[] = [];
  if (childOwned > 0) excluded.push(`${childOwned} child-owned`);
  if (blockedParents.size > 0) excluded.push(`${blockedParents.size} blocked on children`);
  const tail = excluded.length > 0 ? ` (${excluded.join(", ")} excluded)` : "";
  const message = formatReminder(
    "block",
    `turn ending with ${neglected.length} stale/error own task${neglected.length === 1 ? "" : "s"}: ${shown}${suffix}${tail}. Close or continue.`
  );

  return { action: "remind", signature, lastAt: now, count: count + 1, message };
}

// --- Wall-clock nudge -----------------------------------------------------

export interface WallClockState {
  /** Epoch ms of the last wall-clock reminder for this session. */
  lastAt: number;
  /** Consecutive reminders since progress last changed (throttle). */
  streak?: number;
}

export interface WallClockInput {
  /** Pending (running/waiting) entries exist for the session. */
  hasActive: boolean;
  /** Epoch ms of the newest progress write across the session's entries. */
  lastProgressAt?: number;
  /**
   * Epoch ms of the session's last tool call. Unset ⇒ dormant session: it may
   * simply be queued at the inference provider, so do not nag.
   */
  lastToolCallAt?: number;
  /** Epoch ms now. */
  now?: number;
  /** The entry to name in the reminder. */
  target?: NudgeTarget;
}

export interface WallClockOptions {
  /** No progress write for this long ⇒ remind. Default 2 minutes; 0 disables. */
  thresholdMs?: number;
  /** Minimum gap between wall-clock reminders. Default: same as threshold. */
  cooldownMs?: number;
  /**
   * Only remind sessions that called a tool within this window. Default
   * 10 minutes — a session idle longer than this is likely stalled upstream
   * (model queueing/throttling) or abandoned; nagging it is noise.
   */
  activeWindowMs?: number;
  /** Cap reminders per non-progress stretch. Default 3; 0 = uncapped. */
  maxStreak?: number;
}

export function normalizeWallClockMs(raw: unknown, fallback = 10 * 60 * 1000): number {
  const value = (raw ?? {}) as Record<string, unknown>;
  const ms = value.wallClockMs;
  if (ms === 0) return 0; // explicitly disabled
  return typeof ms === "number" && Number.isFinite(ms) && ms >= 60_000 ? ms : fallback;
}

/**
 * Wall-clock reminder: the dimension the call-count monitor cannot cover.
 *
 * The tool-call monitor only fires when the agent calls tools. An agent that
 * is blocked — waiting on a background task it never wrapped in the relay, or
 * simply thinking for a long time — produces no events at all, so without a
 * timer nothing would nudge it. The plugin evaluates this on a 30s interval
 * for every session with pending entries.
 */
export function wallClockNudge(
  state: WallClockState,
  input: WallClockInput,
  options: WallClockOptions = {}
): { action: "remind" | "none"; lastAt: number; streak: number; message?: string } {
  const thresholdMs = options.thresholdMs ?? 2 * 60 * 1000;
  const cooldownMs = options.cooldownMs ?? thresholdMs;
  const activeWindowMs = options.activeWindowMs ?? 10 * 60 * 1000;
  const maxStreak = options.maxStreak ?? 3;
  const now = input.now ?? Date.now();
  const streak = state.streak ?? 0;

  if (thresholdMs <= 0 || !input.hasActive) {
    return { action: "none", lastAt: state.lastAt, streak };
  }
  // Dormant session: no tool calls recently. This is the provider-queueing /
  // abandoned case — the agent may be stalled upstream, not neglectful.
  if (input.lastToolCallAt == null || now - input.lastToolCallAt > activeWindowMs) {
    return { action: "none", lastAt: state.lastAt, streak };
  }
  // Throttle: a few reminders per non-progress stretch is plenty; more only
  // trains the model to ignore them.
  if (maxStreak > 0 && streak >= maxStreak) {
    return { action: "none", lastAt: state.lastAt, streak };
  }

  const lastProgressAt = input.lastProgressAt ?? now;
  const age = now - lastProgressAt;
  if (age < thresholdMs) return { action: "none", lastAt: state.lastAt, streak };
  if (now - state.lastAt < cooldownMs) return { action: "none", lastAt: state.lastAt, streak };

  const message = formatReminder(
    "warn",
    `no progress for ${formatAge(age)}${targetSuffix(input.target)}. Next: update detail/progress or close it; wrap long commands in the relay.`
  );

  return { action: "remind", lastAt: now, streak: streak + 1, message };
}
