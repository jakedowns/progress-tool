/**
 * Custom nudge rules: user/agent-configurable reminders with their own text,
 * trigger, cooldown, criteria, lifetime, and delivery.
 *
 * Pure decision logic plus small atomic stores. The plugin server owns
 * scheduling/delivery; the TUI writes the same rule files directly and the GUI
 * goes through RPC.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { formatAge, isHealthyWaiting, pickTarget } from "./reminders.js";

/** Custom nudges are opt-in: `{ customNudges: true }` on the plugin entry. */
export function customNudgesEnabled(options: unknown): boolean {
  const value = (options ?? {}) as Record<string, unknown>;
  return value.customNudges === true;
}

export type NudgeScope = "global" | "project" | "session";
export type NudgeSeverity = "info" | "warn" | "block";
export type NudgeDelivery = "context-replace" | "context-alongside" | "synthetic";
export type NudgeStatus = "pending" | "running" | "waiting" | "done" | "error";

export type NudgeTrigger =
  | { type: "interval"; everyMs: number }
  | { type: "steps"; everySteps: number }
  | { type: "either"; everyMs?: number; everySteps?: number }
  | { type: "event" };

export interface NudgeCriteria {
  statuses?: NudgeStatus[];
  staleAfterMs?: number;
  noProgressAfterMs?: number;
  noProgressAfterSteps?: number;
  inFlight?: "only" | "never" | "any";
  tree?: "empty" | "nonempty";
  idleOnly?: boolean;
  entryIds?: string[];
  sessions?: "self" | "children" | "all";
}

export interface CustomNudgeRule {
  id: string;
  title?: string;
  enabled: boolean;
  scope: NudgeScope;
  text: string;
  severity: NudgeSeverity;
  trigger: NudgeTrigger;
  cooldownMs: number;
  criteria: NudgeCriteria;
  delivery: NudgeDelivery;
  ttlMs: number;
  maxFires: number;
  /** Epoch ms the rule was created; used for TTL. */
  createdAt?: number;
  /** Human-readable origin (`user`, `agent`, `config`). */
  source?: string;
}

export interface NudgeRuleFile {
  version: 1;
  rules: CustomNudgeRule[];
}

export interface NormalizeResult {
  ok: boolean;
  rule?: CustomNudgeRule;
  errors: string[];
  warnings: string[];
}

export interface NudgeEntry {
  key?: string;
  id: string;
  title?: string | null;
  status?: string | null;
  detail?: string | null;
  updatedAt?: number | null;
  sessionId?: string | null;
  parentId?: string | null;
  dismissed?: unknown;
  cleared?: unknown;
}

export interface NudgeMatchContext {
  now: number;
  entries: readonly NudgeEntry[];
  stepsSinceProgress: number;
  lastProgressAt: number;
  inFlight: boolean;
  idle: boolean;
}

export interface NudgeMatch {
  matched: boolean;
  entries: NudgeEntry[];
  reason?: string;
}

export interface NudgeRuntime {
  createdAt: number;
  fires: number;
  lastFiredAt: number;
  lastStepCount: number;
  lastEvaluatedAt: number;
}

export interface NudgeEvaluation {
  fire: boolean;
  reason?: string;
  match?: NudgeMatch;
  text?: string;
  runtime: NudgeRuntime;
}

export const NUDGE_RULE_LIMIT = 20;
export const NUDGE_TOTAL_LIMIT = 50;
export const NUDGE_TEXT_LIMIT = 240;
export const NUDGE_PLACEHOLDERS = ["id", "title", "status", "age", "count", "action"] as const;
export const NUDGE_ACTIONS: Record<NudgeSeverity, string> = {
  info: "update detail when convenient",
  warn: "update detail/progress or close it",
  block: "update or close it now",
};

const KNOWN_STATUSES: readonly NudgeStatus[] = [
  "pending",
  "running",
  "waiting",
  "done",
  "error",
];
const SCOPES: readonly NudgeScope[] = ["global", "project", "session"];
const DELIVERIES: readonly NudgeDelivery[] = [
  "context-replace",
  "context-alongside",
  "synthetic",
];
const SEVERITIES: readonly NudgeSeverity[] = ["info", "warn", "block"];
const MIN_TRIGGER_MS = 5_000;
const MAX_TRIGGER_MS = 24 * 60 * 60 * 1000;
const MIN_COOLDOWN_MS = 0;
const MAX_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const MIN_TTL_MS = 10_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MIN_STALE_MS = 30_000;

const clampInt = (value: unknown, min: number, max: number, fallback: number): number => {
  const number = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(number)));
};

const asScope = (value: unknown, fallback: NudgeScope = "session"): NudgeScope =>
  SCOPES.includes(value as NudgeScope) ? (value as NudgeScope) : fallback;

const asSeverity = (value: unknown, fallback: NudgeSeverity = "warn"): NudgeSeverity =>
  SEVERITIES.includes(value as NudgeSeverity) ? (value as NudgeSeverity) : fallback;

const asDelivery = (
  value: unknown,
  fallback: NudgeDelivery = "context-alongside"
): NudgeDelivery => (DELIVERIES.includes(value as NudgeDelivery) ? (value as NudgeDelivery) : fallback);

const asId = (value: unknown): string =>
  String(value ?? "")
    .trim()
    .replace(/\s+/g, "-");

/** Parse `30s`, `5m`, `2h`, `1d`, or a raw millisecond number. */
export function parseNudgeDuration(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  if (typeof value !== "string" || !value.trim()) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number.parseFloat(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  const factor =
    unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : unit === "s" ? 1_000 : 1;
  return Math.max(0, Math.round(amount * factor));
}

/** Compact duration for status output (`5m`, `2h`, `30s`). */
export function formatNudgeDuration(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "off";
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

/** Placeholders are optional, but unknown braces are almost always a typo. */
export function invalidNudgePlaceholders(text: string): string[] {
  const found = new Set<string>();
  for (const match of String(text ?? "").matchAll(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g)) {
    if (!(NUDGE_PLACEHOLDERS as readonly string[]).includes(match[1])) found.add(match[1]);
  }
  return [...found];
}

function normalizeTrigger(raw: unknown): { trigger: NudgeTrigger; errors: string[] } {
  const errors: string[] = [];
  const value = (raw ?? {}) as Record<string, unknown>;
  const type = String(value.type ?? "interval");
  const everyMsRaw = parseNudgeDuration(value.everyMs ?? value.every);
  const everyStepsRaw =
    typeof value.everySteps === "number" ? value.everySteps : Number(value.everySteps ?? Number.NaN);

  if (type === "event") return { trigger: { type: "event" }, errors };
  if (type === "steps") {
    if (!Number.isFinite(everyStepsRaw) || everyStepsRaw < 1) {
      errors.push("trigger.everySteps must be at least 1");
      return { trigger: { type: "steps", everySteps: 3 }, errors };
    }
    return {
      trigger: { type: "steps", everySteps: clampInt(everyStepsRaw, 1, 10_000, 3) },
      errors,
    };
  }
  if (type === "either") {
    const everyMs =
      everyMsRaw == null ? undefined : clampInt(everyMsRaw, MIN_TRIGGER_MS, MAX_TRIGGER_MS, 300_000);
    const everySteps =
      Number.isFinite(everyStepsRaw) && everyStepsRaw > 0
        ? clampInt(everyStepsRaw, 1, 10_000, 3)
        : undefined;
    if (everyMs == null && everySteps == null) {
      errors.push("trigger.either needs everyMs and/or everySteps");
      return { trigger: { type: "either", everyMs: 300_000 }, errors };
    }
    return {
      trigger: {
        type: "either",
        ...(everyMs != null ? { everyMs } : {}),
        ...(everySteps != null ? { everySteps } : {}),
      },
      errors,
    };
  }
  return {
    trigger: {
      type: "interval",
      everyMs:
        everyMsRaw == null ? 300_000 : clampInt(everyMsRaw, MIN_TRIGGER_MS, MAX_TRIGGER_MS, 300_000),
    },
    errors,
  };
}

function normalizeCriteria(raw: unknown): NudgeCriteria {
  if (!raw || typeof raw !== "object") return {};
  const value = raw as Record<string, unknown>;
  const criteria: NudgeCriteria = {};
  if (Array.isArray(value.statuses)) {
    const statuses = value.statuses
      .map((status) => String(status))
      .filter((status): status is NudgeStatus =>
        KNOWN_STATUSES.includes(status as NudgeStatus)
      );
    if (statuses.length > 0) criteria.statuses = [...new Set(statuses)];
  }
  const stale = parseNudgeDuration(value.staleAfterMs ?? value.staleAfter);
  if (stale != null && stale >= MIN_STALE_MS) criteria.staleAfterMs = stale;
  const noProgressMs = parseNudgeDuration(value.noProgressAfterMs ?? value.noProgressAfter);
  if (noProgressMs != null && noProgressMs >= MIN_STALE_MS) {
    criteria.noProgressAfterMs = noProgressMs;
  }
  const noProgressSteps =
    typeof value.noProgressAfterSteps === "number"
      ? value.noProgressAfterSteps
      : Number(value.noProgressAfterSteps ?? Number.NaN);
  if (Number.isFinite(noProgressSteps) && noProgressSteps >= 1) {
    criteria.noProgressAfterSteps = clampInt(noProgressSteps, 1, 10_000, 3);
  }
  if (value.inFlight === "only" || value.inFlight === "never" || value.inFlight === "any") {
    criteria.inFlight = value.inFlight;
  }
  if (value.tree === "empty" || value.tree === "nonempty") criteria.tree = value.tree;
  if (value.idleOnly === true) criteria.idleOnly = true;
  if (Array.isArray(value.entryIds)) {
    const ids = value.entryIds.map((id) => String(id).trim()).filter(Boolean);
    if (ids.length > 0) criteria.entryIds = [...new Set(ids)].slice(0, 50);
  }
  if (value.sessions === "self" || value.sessions === "children" || value.sessions === "all") {
    criteria.sessions = value.sessions;
  }
  return criteria;
}

/** Validate and normalize one rule. Never throws; returns errors for the UI. */
export function normalizeNudgeRule(raw: unknown, fallbackScope: NudgeScope = "session"): NormalizeResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["rule must be an object"], warnings };
  }
  const value = raw as Record<string, unknown>;
  const id = asId(value.id);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
    errors.push("id must be a 1-64 character slug (letters, numbers, . _ -)");
  }
  let text = String(value.text ?? "").replace(/\s+/g, " ").trim();
  if (!text) errors.push("text is required");
  if (text.length > NUDGE_TEXT_LIMIT) {
    warnings.push(`text truncated to ${NUDGE_TEXT_LIMIT} characters`);
    text = `${text.slice(0, NUDGE_TEXT_LIMIT - 1).trimEnd()}…`;
  }
  const unknown = invalidNudgePlaceholders(text);
  if (unknown.length > 0) {
    errors.push(`unknown placeholder(s): ${unknown.map((name) => `{${name}}`).join(", ")}`);
  }

  const severity = asSeverity(value.severity);
  const delivery = asDelivery(value.delivery);
  if (delivery === "synthetic" && severity !== "block") {
    errors.push('delivery "synthetic" requires severity "block"');
  }

  const { trigger, errors: triggerErrors } = normalizeTrigger(value.trigger);
  errors.push(...triggerErrors);

  const rule: CustomNudgeRule = {
    id,
    enabled: value.enabled !== false,
    scope: asScope(value.scope, fallbackScope),
    text,
    severity,
    trigger,
    cooldownMs: clampInt(
      parseNudgeDuration(value.cooldownMs ?? value.cooldown) ?? 120_000,
      MIN_COOLDOWN_MS,
      MAX_COOLDOWN_MS,
      120_000
    ),
    criteria: normalizeCriteria(value.criteria ?? value),
    delivery,
    ttlMs:
      value.ttlMs === 0 || value.ttl === 0
        ? 0
        : clampInt(
            parseNudgeDuration(value.ttlMs ?? value.ttl) ?? 3_600_000,
            MIN_TTL_MS,
            MAX_TTL_MS,
            3_600_000
          ),
    maxFires: clampInt(value.maxFires ?? 0, 0, 1_000, 0),
  };
  if (value.title != null && String(value.title).trim()) {
    rule.title = String(value.title).trim().slice(0, 120);
  }
  if (typeof value.createdAt === "number" && Number.isFinite(value.createdAt)) {
    rule.createdAt = Math.floor(value.createdAt);
  }
  if (value.source === "user" || value.source === "agent" || value.source === "config") {
    rule.source = value.source;
  }
  return { ok: errors.length === 0, rule, errors, warnings };
}

export type NudgePreset = "replace" | "alongside" | "block" | "custom";

export interface NudgePresetChoice {
  value: NudgePreset;
  title: string;
  description: string;
}

export const NUDGE_PRESETS: readonly NudgePresetChoice[] = [
  {
    value: "replace",
    title: "Replace built-ins (recommended)",
    description: "One [warn] context reminder every 5m; pauses the built-in nudges while active.",
  },
  {
    value: "alongside",
    title: "Alongside built-ins",
    description: "Same timing, but built-in nudges keep running; identical text is deduped.",
  },
  {
    value: "block",
    title: "Synthetic block",
    description: "A real turn input when it fires. Use for hard stop conditions only.",
  },
  {
    value: "custom",
    title: "Custom",
    description: "Choose trigger, criteria, delivery, TTL, and fire cap yourself.",
  },
];

export function presetDefaults(preset: NudgePreset): Partial<CustomNudgeRule> {
  switch (preset) {
    case "replace":
      return {
        delivery: "context-replace",
        severity: "warn",
        trigger: { type: "interval", everyMs: 300_000 },
        cooldownMs: 120_000,
        ttlMs: 3_600_000,
        maxFires: 0,
      };
    case "alongside":
      return {
        delivery: "context-alongside",
        severity: "warn",
        trigger: { type: "interval", everyMs: 300_000 },
        cooldownMs: 120_000,
        ttlMs: 3_600_000,
        maxFires: 0,
      };
    case "block":
      return {
        delivery: "synthetic",
        severity: "block",
        trigger: { type: "interval", everyMs: 300_000 },
        cooldownMs: 120_000,
        ttlMs: 3_600_000,
        maxFires: 1,
      };
    default:
      return {};
  }
}

export function buildNudgeRule(
  input: Record<string, unknown>,
  preset: NudgePreset = "custom",
  fallbackScope: NudgeScope = "session"
): NormalizeResult {
  return normalizeNudgeRule({ ...presetDefaults(preset), ...input }, fallbackScope);
}

/** Merge scopes; disabled rules in a narrower scope mute the same id above. */
export function mergeNudgeRules(layers: {
  global?: readonly CustomNudgeRule[];
  project?: readonly CustomNudgeRule[];
  session?: readonly CustomNudgeRule[];
}): CustomNudgeRule[] {
  const disabled = (rules: readonly CustomNudgeRule[] | undefined) =>
    new Set((rules ?? []).filter((rule) => !rule.enabled).map((rule) => rule.id));
  const projectTombstones = disabled(layers.project);
  const sessionTombstones = disabled(layers.session);

  const effective: CustomNudgeRule[] = [];
  // Narrower scope first: it wins on identical rendered output.
  for (const rule of layers.session ?? []) {
    if (rule.enabled) effective.push(rule);
  }
  for (const rule of layers.project ?? []) {
    if (rule.enabled && !sessionTombstones.has(rule.id)) effective.push(rule);
  }
  for (const rule of layers.global ?? []) {
    if (
      rule.enabled &&
      !sessionTombstones.has(rule.id) &&
      !projectTombstones.has(rule.id)
    ) {
      effective.push(rule);
    }
  }
  return effective;
}

/** Runtime is per session even for global/project rules: cooldown and TTL are
 * per recipient, not per rule definition. */
export function ruleRuntimeKey(rule: CustomNudgeRule, sessionID: string): string {
  return `${sessionID}:${rule.scope}:${rule.id}`;
}

export function emptyNudgeRuntime(rule: CustomNudgeRule, now: number): NudgeRuntime {
  return {
    createdAt: rule.createdAt ?? now,
    fires: 0,
    lastFiredAt: 0,
    lastStepCount: 0,
    lastEvaluatedAt: 0,
  };
}

export function ruleExpired(rule: CustomNudgeRule, runtime: NudgeRuntime, now: number): boolean {
  if (rule.ttlMs > 0 && now - runtime.createdAt >= rule.ttlMs) return true;
  return rule.maxFires > 0 && runtime.fires >= rule.maxFires;
}

/** True while a context-replace rule should suppress the built-in reminders. */
export function ruleSuppressesBuiltins(
  rule: CustomNudgeRule,
  runtime: NudgeRuntime,
  now: number
): boolean {
  return (
    rule.enabled &&
    rule.delivery === "context-replace" &&
    !ruleExpired(rule, runtime, now)
  );
}

/** AND across categories, OR inside lists. */
export function matchNudgeCriteria(criteria: NudgeCriteria, ctx: NudgeMatchContext): NudgeMatch {
  let candidates = [...ctx.entries].filter((entry) => entry && !entry.dismissed && !entry.cleared);

  if (criteria.sessions === "self" || criteria.sessions === "children" || criteria.sessions === "all") {
    // Session scoping is applied by the caller before matching.
  }

  if (criteria.statuses && criteria.statuses.length > 0) {
    const allowed = new Set(criteria.statuses);
    candidates = candidates.filter((entry) => allowed.has(String(entry.status) as NudgeStatus));
  }

  if (criteria.entryIds && criteria.entryIds.length > 0) {
    const allowed = new Set(criteria.entryIds);
    candidates = candidates.filter((entry) => allowed.has(entry.id));
  }

  if (criteria.staleAfterMs != null) {
    const threshold = criteria.staleAfterMs;
    const explicitWaiting = criteria.statuses?.includes("waiting") === true;
    candidates = candidates.filter((entry) => {
      if (!explicitWaiting && isHealthyWaiting(entry, ctx.now, threshold)) return false;
      return entry.updatedAt == null || ctx.now - entry.updatedAt >= threshold;
    });
  }

  if (criteria.noProgressAfterMs != null && ctx.now - ctx.lastProgressAt < criteria.noProgressAfterMs) {
    return { matched: false, entries: [], reason: "progress-recent" };
  }
  if (
    criteria.noProgressAfterSteps != null &&
    ctx.stepsSinceProgress < criteria.noProgressAfterSteps
  ) {
    return { matched: false, entries: [], reason: "steps-below" };
  }

  if (criteria.inFlight === "only" && !ctx.inFlight) {
    return { matched: false, entries: [], reason: "not-in-flight" };
  }
  if (criteria.inFlight === "never" && ctx.inFlight) {
    return { matched: false, entries: [], reason: "in-flight" };
  }

  const treeNonEmpty = candidates.length > 0;
  if (criteria.tree === "empty" && treeNonEmpty) {
    return { matched: false, entries: [], reason: "tree-nonempty" };
  }
  if (criteria.tree === "nonempty" && !treeNonEmpty) {
    return { matched: false, entries: [], reason: "tree-empty" };
  }

  if (criteria.idleOnly && !ctx.idle) {
    return { matched: false, entries: [], reason: "not-idle" };
  }

  // A criterion that narrows to no entries is not a match; a rule with no
  // entry-level criteria may fire on global conditions (tree/idle/steps).
  const entryCriteria =
    criteria.statuses != null ||
    criteria.entryIds != null ||
    criteria.staleAfterMs != null;
  if (entryCriteria && candidates.length === 0) {
    return { matched: false, entries: [], reason: "no-entry-match" };
  }

  return { matched: true, entries: candidates };
}

function triggerReady(rule: CustomNudgeRule, runtime: NudgeRuntime, ctx: NudgeMatchContext): boolean {
  const trigger = rule.trigger;
  if (trigger.type === "event") return true;
  const intervalReady =
    trigger.type === "interval" || trigger.type === "either"
      ? trigger.everyMs != null &&
        (runtime.lastFiredAt === 0 || ctx.now - runtime.lastFiredAt >= trigger.everyMs)
      : false;
  const stepsReady =
    trigger.type === "steps" || trigger.type === "either"
      ? trigger.everySteps != null &&
        ctx.stepsSinceProgress >= trigger.everySteps &&
        ctx.stepsSinceProgress !== runtime.lastStepCount
      : false;
  if (trigger.type === "interval") return intervalReady;
  if (trigger.type === "steps") return stepsReady;
  return intervalReady || stepsReady;
}

/** Replace placeholders from the oldest matched entry. */
export function renderNudgeText(
  rule: CustomNudgeRule,
  matched: readonly NudgeEntry[],
  now: number
): string {
  const target = pickTarget(matched, now);
  const values: Record<string, string> = {
    id: target?.id ?? "the tree",
    title: target?.title ?? target?.id ?? "the tree",
    status: target?.status ?? "none",
    age: target ? formatAge(target.ageMs) : "unknown",
    count: String(matched.length),
    action: NUDGE_ACTIONS[rule.severity],
  };
  const text = rule.text.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (whole, name) =>
    name in values ? values[name] : whole
  );
  return text.replace(/\s+/g, " ").trim();
}

export function evaluateNudgeRule(
  rule: CustomNudgeRule,
  runtime: NudgeRuntime,
  ctx: NudgeMatchContext
): NudgeEvaluation {
  if (!rule.enabled) return { fire: false, reason: "disabled", runtime };
  if (ruleExpired(rule, runtime, ctx.now)) return { fire: false, reason: "expired", runtime };
  if (ctx.inFlight && rule.severity !== "block") {
    return { fire: false, reason: "in-flight", runtime };
  }
  if (runtime.lastFiredAt > 0 && ctx.now - runtime.lastFiredAt < rule.cooldownMs) {
    return { fire: false, reason: "cooldown", runtime };
  }
  if (!triggerReady(rule, runtime, ctx)) {
    return { fire: false, reason: "not-due", runtime };
  }
  const match = matchNudgeCriteria(rule.criteria, ctx);
  if (!match.matched) return { fire: false, reason: match.reason ?? "no-match", match, runtime };
  const text = renderNudgeText(rule, match.entries, ctx.now);
  if (!text) return { fire: false, reason: "empty-text", match, runtime };
  return {
    fire: true,
    match,
    text,
    runtime: {
      ...runtime,
      fires: runtime.fires + 1,
      lastFiredAt: ctx.now,
      lastStepCount: ctx.stepsSinceProgress,
      lastEvaluatedAt: ctx.now,
    },
  };
}

/** Next scheduled check, for status output. Event/steps rules have no clock. */
export function nextNudgeFireAt(
  rule: CustomNudgeRule,
  runtime: NudgeRuntime,
  now: number
): number | null {
  if (ruleExpired(rule, runtime, now)) return null;
  if (rule.trigger.type === "interval" || rule.trigger.type === "either") {
    const everyMs = rule.trigger.everyMs;
    if (everyMs == null) return null;
    if (runtime.lastFiredAt === 0) return now;
    return runtime.lastFiredAt + everyMs;
  }
  return null;
}

export function describeNudgeTrigger(rule: CustomNudgeRule): string {
  const trigger = rule.trigger;
  if (trigger.type === "event") return "on event";
  if (trigger.type === "steps") return `every ${trigger.everySteps} steps`;
  if (trigger.type === "either") {
    const parts = [
      trigger.everyMs != null ? `every ${formatNudgeDuration(trigger.everyMs)}` : null,
      trigger.everySteps != null ? `${trigger.everySteps} steps` : null,
    ].filter(Boolean);
    return parts.length > 0 ? `either ${parts.join(" or ")}` : "either";
  }
  return `every ${formatNudgeDuration(trigger.everyMs)}`;
}

export function describeNudgeCriteria(rule: CustomNudgeRule): string {
  const parts: string[] = [];
  const c = rule.criteria;
  if (c.statuses?.length) parts.push(`status ${c.statuses.join("/")}`);
  if (c.staleAfterMs != null) parts.push(`stale > ${formatNudgeDuration(c.staleAfterMs)}`);
  if (c.noProgressAfterMs != null) parts.push(`no progress > ${formatNudgeDuration(c.noProgressAfterMs)}`);
  if (c.noProgressAfterSteps != null) parts.push(`${c.noProgressAfterSteps}+ steps`);
  if (c.inFlight && c.inFlight !== "any") parts.push(c.inFlight === "only" ? "in flight" : "idle only");
  if (c.tree) parts.push(`tree ${c.tree}`);
  if (c.idleOnly) parts.push("turn end");
  if (c.entryIds?.length) parts.push(`ids ${c.entryIds.join(",")}`);
  if (c.sessions && c.sessions !== "self") parts.push(`sessions ${c.sessions}`);
  return parts.length > 0 ? parts.join("; ") : "any open tree";
}

// --- Stores -----------------------------------------------------------------

export interface NudgePaths {
  globalFile: string;
  projectFile: string;
  sessionFile: string;
  projectRoot: string;
}

/** Nearest ancestor with `.git` or `.opencode`; falls back to the directory. */
export function findProjectRoot(
  directory: string,
  exists: (candidate: string) => boolean = existsSync
): string {
  let current = path.resolve(directory);
  while (true) {
    if (exists(path.join(current, ".git")) || exists(path.join(current, ".opencode"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(directory);
    current = parent;
  }
}

export function resolveNudgePaths(options: {
  directory: string;
  home?: string;
}): NudgePaths {
  const home = options.home ?? homedir();
  const config = path.join(home, ".config", "opencode");
  const projectRoot = findProjectRoot(options.directory);
  return {
    globalFile: path.join(config, "progress-nudge.json"),
    projectFile: path.join(projectRoot, ".opencode", "progress-nudge.json"),
    sessionFile: path.join(config, "progress-nudge-sessions.json"),
    projectRoot,
  };
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function atomicWriteJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

export interface ReadRulesResult {
  rules: CustomNudgeRule[];
  errors: string[];
}

export function readNudgeRuleFile(
  file: string,
  scope: NudgeScope
): ReadRulesResult {
  const raw = readJson(file) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return { rules: [], errors: [] };
  const list = Array.isArray(raw.rules) ? raw.rules : [];
  const rules: CustomNudgeRule[] = [];
  const errors: string[] = [];
  for (const item of list) {
    const result = normalizeNudgeRule({ ...(item as Record<string, unknown>), scope }, scope);
    if (result.ok && result.rule) {
      rules.push(result.rule);
    } else {
      errors.push(
        `${scope}:${String((item as Record<string, unknown>)?.id ?? "?")}: ${result.errors.join("; ")}`
      );
    }
  }
  return { rules: rules.slice(0, NUDGE_RULE_LIMIT), errors };
}

export function writeNudgeRuleFile(file: string, rules: readonly CustomNudgeRule[]): void {
  const payload: NudgeRuleFile = { version: 1, rules: rules.slice(0, NUDGE_RULE_LIMIT) };
  atomicWriteJson(file, payload);
}

export function upsertNudgeRule(
  file: string,
  scope: NudgeScope,
  rule: CustomNudgeRule
): ReadRulesResult {
  const existing = readNudgeRuleFile(file, scope);
  const rules = existing.rules.filter((candidate) => candidate.id !== rule.id);
  rules.push({ ...rule, scope });
  if (rules.length > NUDGE_RULE_LIMIT) {
    return {
      rules: existing.rules,
      errors: [`${scope} scope is limited to ${NUDGE_RULE_LIMIT} rules`],
    };
  }
  writeNudgeRuleFile(file, rules);
  return { rules, errors: existing.errors };
}

export function setNudgeRuleEnabled(
  file: string,
  scope: NudgeScope,
  id: string,
  enabled: boolean
): ReadRulesResult {
  const existing = readNudgeRuleFile(file, scope);
  const found = existing.rules.find((rule) => rule.id === id);
  if (!found) {
    if (!enabled) {
      // A tombstone: mute a broader rule with this id without inventing text.
      const tombstone: CustomNudgeRule = {
        id,
        enabled: false,
        scope,
        text: "disabled",
        severity: "warn",
        trigger: { type: "event" },
        cooldownMs: 0,
        criteria: {},
        delivery: "context-alongside",
        ttlMs: 0,
        maxFires: 0,
        createdAt: Date.now(),
      };
      const rules = [...existing.rules, tombstone];
      writeNudgeRuleFile(file, rules);
      return { rules, errors: existing.errors };
    }
    return { rules: existing.rules, errors: [`${scope}:${id} not found`] };
  }
  const rules = existing.rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule));
  writeNudgeRuleFile(file, rules);
  return { rules, errors: existing.errors };
}

export function clearNudgeRule(
  file: string,
  scope: NudgeScope,
  id: string
): ReadRulesResult {
  const existing = readNudgeRuleFile(file, scope);
  const rules = existing.rules.filter((rule) => rule.id !== id);
  writeNudgeRuleFile(file, rules);
  return { rules, errors: existing.errors };
}

interface SessionRuleFile {
  version: 1;
  sessions: Record<string, CustomNudgeRule[]>;
}

export function readSessionNudgeRules(file: string, sessionID: string): ReadRulesResult {
  const raw = readJson(file) as SessionRuleFile | undefined;
  const list = raw?.sessions?.[sessionID];
  if (!Array.isArray(list)) return { rules: [], errors: [] };
  const rules: CustomNudgeRule[] = [];
  const errors: string[] = [];
  for (const item of list) {
    const result = normalizeNudgeRule({ ...(item as Record<string, unknown>), scope: "session" }, "session");
    if (result.ok && result.rule) rules.push(result.rule);
    else {
      errors.push(
        `session:${String((item as Record<string, unknown>)?.id ?? "?")}: ${result.errors.join("; ")}`
      );
    }
  }
  return { rules: rules.slice(0, NUDGE_RULE_LIMIT), errors };
}

function readSessionMapFile(file: string): SessionRuleFile {
  const raw = readJson(file) as SessionRuleFile | undefined;
  if (!raw || typeof raw !== "object" || typeof raw.sessions !== "object" || raw.sessions == null) {
    return { version: 1, sessions: {} };
  }
  return { version: 1, sessions: raw.sessions };
}

export function upsertSessionNudgeRule(
  file: string,
  sessionID: string,
  rule: CustomNudgeRule
): ReadRulesResult {
  const store = readSessionMapFile(file);
  const existing = readSessionNudgeRules(file, sessionID);
  const rules = existing.rules.filter((candidate) => candidate.id !== rule.id);
  rules.push({ ...rule, scope: "session" });
  if (rules.length > NUDGE_RULE_LIMIT) {
    return {
      rules: existing.rules,
      errors: [`session scope is limited to ${NUDGE_RULE_LIMIT} rules`],
    };
  }
  store.sessions[sessionID] = rules;
  atomicWriteJson(file, store);
  return { rules, errors: existing.errors };
}

export function setSessionNudgeRuleEnabled(
  file: string,
  sessionID: string,
  id: string,
  enabled: boolean
): ReadRulesResult {
  const existing = readSessionNudgeRules(file, sessionID);
  const found = existing.rules.find((rule) => rule.id === id);
  if (!found) {
    return { rules: existing.rules, errors: [`session:${id} not found`] };
  }
  const rules = existing.rules.map((rule) => (rule.id === id ? { ...rule, enabled } : rule));
  const store = readSessionMapFile(file);
  store.sessions[sessionID] = rules;
  atomicWriteJson(file, store);
  return { rules, errors: existing.errors };
}

export function clearSessionNudgeRule(
  file: string,
  sessionID: string,
  id: string
): ReadRulesResult {
  const existing = readSessionNudgeRules(file, sessionID);
  const rules = existing.rules.filter((rule) => rule.id !== id);
  const store = readSessionMapFile(file);
  if (rules.length > 0) store.sessions[sessionID] = rules;
  else delete store.sessions[sessionID];
  atomicWriteJson(file, store);
  return { rules, errors: existing.errors };
}

/** Include descendant sessions when a rule asks for children/all. */
export function sessionScopeIds(
  sessionID: string,
  links: Record<string, { parentID?: string | null }>,
  scope: "self" | "children" | "all"
): Set<string> {
  if (scope === "all") return new Set();
  const ids = new Set<string>([sessionID]);
  if (scope === "children") {
    let changed = true;
    while (changed) {
      changed = false;
      for (const [child, link] of Object.entries(links)) {
        if (!link?.parentID || ids.has(child)) continue;
        if (ids.has(link.parentID)) {
          ids.add(child);
          changed = true;
        }
      }
    }
  }
  return ids;
}

/** Filter the shared store for the rule's session scope. */
export function entriesForSessions(
  entries: readonly NudgeEntry[],
  scope: "self" | "children" | "all",
  sessionID: string,
  links: Record<string, { parentID?: string | null }>
): NudgeEntry[] {
  if (scope === "all") return [...entries];
  const ids = sessionScopeIds(sessionID, links, scope);
  return entries.filter((entry) => {
    if (entry.sessionId && ids.has(entry.sessionId)) return true;
    // Legacy entries may lack sessionId; the storage key still carries it.
    return entry.key != null && [...ids].some((id) => entry.key!.startsWith(`${id}:`));
  });
}
