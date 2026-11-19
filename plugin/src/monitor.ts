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
 * entry's updatedAt, which resets the staleness clock and the
 * calls-since-progress counter.
 *
 * Pure decision logic — no I/O — so it is unit-testable. The plugin server
 * part applies the decision: an instructions entry (visible to the model at
 * the next step boundary, without queuing a message turn) for "nudge" /
 * "stale-nudge", plus a synthetic message for "force".
 */

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
}

export type MonitorAction = "none" | "nudge" | "force" | "clear" | "stale-nudge";

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
): { action: MonitorAction; count: number; callsSinceProgress: number; lastStaleNudgeAt: number } {
  const threshold = options.threshold ?? 3;
  const strictMode = options.strictMode ?? 'nudge';
  const staleAfterMs = options.staleAfterMs ?? 5 * 60 * 1000;
  const staleMinCalls = options.staleMinCalls ?? 3;
  const cooldownMs = options.cooldownMs ?? 2 * 60 * 1000;

  const untouched = {
    count: monitor.count,
    callsSinceProgress: monitor.callsSinceProgress,
    lastStaleNudgeAt: monitor.lastStaleNudgeAt,
  };

  if (strictMode === 'off') return { action: 'none', count: 0, callsSinceProgress: 0, lastStaleNudgeAt: monitor.lastStaleNudgeAt };

  if (input.isProgressCall) {
    return {
      action: monitor.nudged ? 'clear' : 'none',
      count: 0,
      callsSinceProgress: 0,
      lastStaleNudgeAt: monitor.lastStaleNudgeAt,
    };
  }

  // A relay tick (or any write since the last observation) is progress
  // activity: reset the staleness clock and the counter.
  const callsSinceProgress = input.progressAdvanced ? 0 : monitor.callsSinceProgress + 1;
  const now = input.now ?? Date.now();
  const lastProgressAt = input.lastProgressAt ?? now;

  if (input.hasActive) {
    // Compliant on the "has a task" axis. A standing nudge entry clears only
    // when actual progress happened (a progress call or a store write) —
    // otherwise a stale-progress reminder would be wiped by the very next
    // tool call before the agent acted on it.
    const progressed = input.progressAdvanced === true;
    const clearAction: MonitorAction = monitor.nudged && progressed ? 'clear' : 'none';
    const age = now - lastProgressAt;
    if (
      age >= staleAfterMs &&
      callsSinceProgress >= staleMinCalls &&
      now - monitor.lastStaleNudgeAt >= cooldownMs
    ) {
      return { action: 'stale-nudge', count: 0, callsSinceProgress, lastStaleNudgeAt: now };
    }
    return { action: clearAction, count: 0, callsSinceProgress, lastStaleNudgeAt: monitor.lastStaleNudgeAt };
  }

  const count = monitor.count + 1;
  if (count >= threshold && !monitor.nudged) {
    if (strictMode === 'force' && !monitor.forced) {
      return { action: 'force', count, callsSinceProgress, lastStaleNudgeAt: monitor.lastStaleNudgeAt };
    }
    return { action: 'nudge', count, callsSinceProgress, lastStaleNudgeAt: monitor.lastStaleNudgeAt };
  }
  return { ...untouched, action: 'none', count, callsSinceProgress };
}

/** The standing instructions-entry nudge text (silent run). */
export function silentRunNudge(count: number): string {
  return `⚠ STRICT MODE: ${count} consecutive tool calls with no progress entry. Call the progress tool NOW (status "running", a stable id, a short title), then keep it current between steps — see the progress-tool skill.`;
}

/** The stale-progress nudge text (pending tasks, unchanged %). */
export function staleProgressNudge(callsSinceProgress: number): string {
  return `⚠ STRICT MODE: ${callsSinceProgress} tool calls since any progress value changed, and you have pending tasks — any updates? Update the running entries now (fresh detail and a 0.0–1.0 progress fraction, or close what is finished), or mark them waiting.`;
}

// --- Relay hint (pre-flight, before the command runs) ---------------------

const LONG_COMMAND_RE =
  /\b(?:npm|pnpm|yarn|bun)\s+(?:test|run\s+(?:build|test|lint|check|typecheck))\b|\b(?:vite\s+build|webpack|rollup|jest|vitest|pytest|cargo\s+(?:build|test)|go\s+(?:build|test)|make\b|gradle|mvn|docker\s+build)\b/i;

/**
 * Detect a long-running command that is NOT already piped through the relay.
 * Returns the command when a hint should be shown, otherwise null. Detection
 * only — the plugin never rewrites the command.
 */
export function relayHintFor(command: string | null | undefined): string | null {
  if (!command || typeof command !== "string") return null;
  if (/progress-relay|progress-emit/.test(command)) return null;
  if (!LONG_COMMAND_RE.test(command)) return null;
  return command.trim();
}

export function relayHintMessage(command: string): string {
  const shown = command.length > 90 ? `${command.slice(0, 87)}…` : command;
  return [
    `⚠ This looks long-running — wrap it in the out-of-band relay so the UI stays live at zero token cost:`,
    `  progress-relay --id <id> -- ${shown}`,
    `  # or: ${shown} | progress-relay --id <id>`,
    `Wrap mode maps the exit code to done/error. Run it in the background and keep working.`,
  ].join("\n");
}

// --- Idle reminder (turn-end nudge) --------------------------------------

export interface IdleEntry {
  id: string;
  title?: string;
  status: string;
  dismissed?: { at: number } | null;
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
  // Relay-driven tasks tick several times per second; only entries nobody is
  // writing to deserve an idle nag. Unknown timestamps count as stale.
  const staleAfterMs = options.staleAfterMs ?? 5 * 60_000;

  const open = entries
    .filter(
      (entry) =>
        (entry.status === "running" || entry.status === "waiting") &&
        !entry.dismissed &&
        (entry.updatedAt == null || now - entry.updatedAt >= staleAfterMs)
    )
    .map((entry) => `${entry.id} (${entry.status})`)
    .sort();
  const signature = open.join(" | ");

  if (open.length === 0) {
    return { action: "none", signature, lastAt: tracker.lastAt, count: 0 };
  }

  const changed = signature !== tracker.signature;
  const count = changed ? 0 : tracker.count;
  if (!changed && (count >= maxPerRun || now - tracker.lastAt < cooldownMs)) {
    return { action: "none", signature, lastAt: tracker.lastAt, count };
  }

  const message = [
    `⚠ IDLE WITH OPEN TASKS (${open.length}): ${open.join(", ")}.`,
    `You are about to go idle, but these progress entries are still running/waiting.`,
    `Close what is finished (status "done" or "error"), mark genuinely blocked work "waiting" with a detail, or continue the work now. Do not leave stale trees behind.`,
  ].join(" ");

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

export function normalizeWallClockMs(raw: unknown, fallback = 2 * 60 * 1000): number {
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

  const minutes = Math.max(1, Math.round(age / 60_000));
  const message = [
    `⚠ WALL CLOCK: it has been ~${minutes} minute${minutes === 1 ? "" : "s"} since any progress value changed, and you still have open tasks.`,
    `Update the tracker now (fresh detail, a 0.0–1.0 progress fraction, or close what is finished).`,
    `If you are waiting on a long-running command, route it through the out-of-band relay so telemetry stays live without polling: progress-relay --id <id> -- <cmd>.`,
  ].join(" ");

  return { action: "remind", lastAt: now, streak: streak + 1, message };
}
