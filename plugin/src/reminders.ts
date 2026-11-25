/**
 * Shared reminder primitives: severity, one-standing-entry dedupe, age
 * formatting, waiting health, and target selection.
 *
 * Pure so the nudge engine, say nudge, and tests can share one vocabulary.
 */

export type ReminderSeverity = "info" | "warn" | "block";

export interface ReminderState {
  severity: ReminderSeverity;
  /** Logical source: strict, wall, idle, relay, say, custom. */
  source: string;
  /** Fully rendered text including the severity prefix. */
  text: string;
  /** Stable hash of the rendered text for dedupe. */
  hash: string;
  /** Epoch ms the text was written. */
  at: number;
}

const SEVERITY_RANK: Record<ReminderSeverity, number> = {
  info: 1,
  warn: 2,
  block: 3,
};

export function normalizeSeverity(value: unknown): ReminderSeverity {
  return value === "block" || value === "info" ? value : "warn";
}

export function reminderHash(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
  }
  return (hash >>> 0).toString(36);
}

/** Render the compact one-line reminder with its tier prefix. */
export function formatReminder(severity: ReminderSeverity, body: string): string {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  return `[${severity}] ${text}`;
}

/**
 * One standing entry: a new reminder replaces the current one only when it
 * outranks it, or shares its tier and actually differs. Identical text is
 * always skipped.
 */
export function shouldReplaceReminder(
  current: ReminderState | undefined,
  next: Pick<ReminderState, "severity" | "text" | "hash">
): boolean {
  if (!current) return true;
  const currentRank = SEVERITY_RANK[current.severity] ?? 0;
  const nextRank = SEVERITY_RANK[next.severity] ?? 0;
  if (nextRank > currentRank) return true;
  if (nextRank < currentRank) return false;
  if (current.hash === next.hash && current.text === next.text) return false;
  return true;
}

/** Compact age for reminder copy; never prints absurd magnitudes. */
export function formatAge(ageMs: number | null | undefined): string {
  if (ageMs == null || !Number.isFinite(ageMs) || ageMs < 0) return "unknown";
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 2) return `${hours}h`;
  return "> 2h";
}

export interface WaitingCandidate {
  status?: string | null;
  detail?: string | null;
  updatedAt?: number | null;
}

/**
 * A waiting entry is healthy when it says why it is waiting and has been
 * touched recently. Healthy waiting is blocked on something external, not
 * neglect.
 */
export function isHealthyWaiting(
  entry: WaitingCandidate,
  now: number,
  staleAfterMs: number
): boolean {
  if (entry.status !== "waiting") return false;
  if (!String(entry.detail ?? "").trim()) return false;
  if (entry.updatedAt == null) return false;
  return now - entry.updatedAt < staleAfterMs;
}

export interface NudgeCandidate {
  id: string;
  title?: string | null;
  status?: string | null;
  detail?: string | null;
  updatedAt?: number | null;
  dismissed?: unknown;
  cleared?: unknown;
}

export interface NudgeTarget {
  id: string;
  title?: string;
  status: string;
  ageMs: number;
}

/**
 * Pick the best entry to name in a reminder: the oldest open task, preferring
 * running/waiting/pending over done/error.
 */
export function pickTarget(
  entries: readonly NudgeCandidate[],
  now: number
): NudgeTarget | undefined {
  const open = entries.filter(
    (entry) =>
      entry &&
      !entry.dismissed &&
      !entry.cleared &&
      (entry.status === "running" ||
        entry.status === "waiting" ||
        entry.status === "pending")
  );
  if (open.length === 0) return undefined;
  const target = open.reduce((oldest, entry) =>
    (entry.updatedAt ?? 0) < (oldest.updatedAt ?? 0) ? entry : oldest
  );
  return {
    id: target.id,
    ...(target.title ? { title: String(target.title) } : {}),
    status: String(target.status ?? "unknown"),
    ageMs: Math.max(0, now - (target.updatedAt ?? now)),
  };
}

/**
 * Global quiet period between non-block reminders, regardless of source.
 * Block reminders bypass it: they exist to resume a stalled turn.
 */
export function reminderGapAllows(
  lastAt: number,
  now: number,
  gapMs: number,
  severity: ReminderSeverity
): boolean {
  if (severity === "block") return true;
  if (!lastAt || gapMs <= 0) return true;
  return now - lastAt >= gapMs;
}
