/**
 * TUI surface for custom progress nudges.
 *
 * The TUI writes the same dedicated rule files as the plugin server, so
 * `/progress nudge` works without an RPC bridge. Runtime counters (fires,
 * next-fire) live in the server process and are shown by the GUI/status RPC.
 */

import {
  NUDGE_PRESETS,
  buildNudgeRule,
  clearNudgeRule,
  clearSessionNudgeRule,
  describeNudgeCriteria,
  describeNudgeTrigger,
  formatNudgeDuration,
  mergeNudgeRules,
  parseNudgeDuration,
  readNudgeRuleFile,
  readSessionNudgeRules,
  resolveNudgePaths,
  setNudgeRuleEnabled,
  setSessionNudgeRuleEnabled,
  upsertNudgeRule,
  upsertSessionNudgeRule,
  type CustomNudgeRule,
  type NudgePreset,
  type NudgeScope,
} from "./custom-nudges.js";

export interface NudgeTuiContext {
  location?: { directory?: string };
  ui: {
    toast: { show(input: { message: string; variant?: string; duration?: number }): void };
    dialog: {
      select<T>(input: {
        title: string;
        options: Array<{ title: string; value: T; description?: string }>;
        current?: T;
      }): Promise<T | undefined>;
      prompt(input: {
        title: string;
        description?: string;
        placeholder?: string;
        value?: string;
      }): Promise<string | undefined>;
      confirm(input: {
        title: string;
        message?: string;
        label?: { confirm?: string; cancel?: string };
        danger?: boolean;
      }): Promise<boolean>;
      alert(input: { title: string; message?: string }): Promise<void>;
    };
  };
}

interface ParsedFlags {
  positional: string[];
  values: Record<string, string>;
  booleans: Set<string>;
}

function parseFlags(args: string): ParsedFlags {
  const tokens = args.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const positional: string[] = [];
  const values: Record<string, string> = {};
  const booleans = new Set<string>();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (!token.startsWith("--")) {
      positional.push(token.replace(/^["']|["']$/g, ""));
      continue;
    }
    const key = token.slice(2);
    if (key === "idle" || key === "one-shot" || key === "event") {
      booleans.add(key);
      continue;
    }
    const next = tokens[i + 1];
    if (next != null && !next.startsWith("--")) {
      values[key] = next.replace(/^["']|["']$/g, "");
      i += 1;
    } else {
      booleans.add(key);
    }
  }
  return { positional, values, booleans };
}

function scoped(context: NudgeTuiContext) {
  return resolveNudgePaths({ directory: context.location?.directory ?? process.cwd() });
}

function allRules(context: NudgeTuiContext, sessionID: string) {
  const paths = scoped(context);
  const global = readNudgeRuleFile(paths.globalFile, "global");
  const project = readNudgeRuleFile(paths.projectFile, "project");
  const session = readSessionNudgeRules(paths.sessionFile, sessionID);
  const merged = mergeNudgeRules({
    global: global.rules,
    project: project.rules,
    session: session.rules,
  });
  return {
    paths,
    global,
    project,
    session,
    merged,
    errors: [...global.errors, ...project.errors, ...session.errors],
  };
}

function row(rule: CustomNudgeRule, effective: boolean, detailed: boolean): string {
  const state = rule.enabled ? (effective ? "on" : "muted") : "off";
  const base = `${rule.scope}:${rule.id} [${state}] ${rule.text}`;
  if (!detailed) return base;
  return [
    base,
    `  ${describeNudgeTrigger(rule)}; ${describeNudgeCriteria(rule)}`,
    `  severity ${rule.severity}, ${rule.delivery}, cooldown ${formatNudgeDuration(rule.cooldownMs)}, ttl ${formatNudgeDuration(rule.ttlMs)}, max fires ${rule.maxFires === 0 ? "unlimited" : rule.maxFires}`,
  ].join("\n");
}

async function showList(context: NudgeTuiContext, sessionID: string, detailed: boolean): Promise<void> {
  const { global, project, session, merged, errors } = allRules(context, sessionID);
  const effective = new Set(merged.map((rule) => `${rule.scope}:${rule.id}`));
  const rows = [
    ...session.rules.map((rule) => row(rule, effective.has(`session:${rule.id}`), detailed)),
    ...project.rules.map((rule) => row(rule, effective.has(`project:${rule.id}`), detailed)),
    ...global.rules.map((rule) => row(rule, effective.has(`global:${rule.id}`), detailed)),
  ];
  const notes: string[] = [];
  if (rows.length === 0) notes.push("No custom nudge rules yet.");
  if (errors.length > 0) notes.push(`Invalid rules: ${errors.join("; ")}`);
  await context.ui.dialog.alert({
    title: "Progress custom nudges",
    message: [...rows, ...notes].join("\n\n"),
  });
}

function parseTarget(raw: string | undefined, sessionID: string): { scope: NudgeScope; id: string } | null {
  if (!raw) return null;
  const [maybeScope, maybeId] = raw.includes(":") ? raw.split(":", 2) : ["session", raw];
  const scope: NudgeScope =
    maybeScope === "global" || maybeScope === "project" || maybeScope === "session"
      ? maybeScope
      : "session";
  const id = (maybeId ?? "").trim();
  if (!id) return null;
  return { scope, id };
}

async function toggle(context: NudgeTuiContext, sessionID: string, args: string, enabled: boolean, clear: boolean) {
  const flags = parseFlags(args);
  const target = parseTarget(flags.positional[0] ?? flags.values.id, sessionID);
  if (!target) {
    context.ui.toast.show({ message: "Use <scope>:<id>, e.g. session:build", variant: "warning" });
    return;
  }
  const paths = scoped(context);
  if (target.scope === "session") {
    const result = clear
      ? clearSessionNudgeRule(paths.sessionFile, sessionID, target.id)
      : setSessionNudgeRuleEnabled(paths.sessionFile, sessionID, target.id, enabled);
    context.ui.toast.show({
      message:
        result.errors.length > 0
          ? result.errors.join("; ")
          : `Nudge session:${target.id} ${clear ? "cleared" : enabled ? "enabled" : "disabled"}.`,
      variant: result.errors.length > 0 ? "warning" : "success",
    });
    return;
  }
  const file = target.scope === "global" ? paths.globalFile : paths.projectFile;
  const result = clear
    ? clearNudgeRule(file, target.scope, target.id)
    : setNudgeRuleEnabled(file, target.scope, target.id, enabled);
  context.ui.toast.show({
    message:
      result.errors.length > 0
        ? result.errors.join("; ")
        : `Nudge ${target.scope}:${target.id} ${clear ? "cleared" : enabled ? "enabled" : "disabled"}.`,
    variant: result.errors.length > 0 ? "warning" : "success",
  });
}

async function saveRule(
  context: NudgeTuiContext,
  sessionID: string,
  rule: CustomNudgeRule
): Promise<boolean> {
  const paths = scoped(context);
  const result =
    rule.scope === "session"
      ? upsertSessionNudgeRule(paths.sessionFile, sessionID, rule)
      : upsertNudgeRule(rule.scope === "global" ? paths.globalFile : paths.projectFile, rule.scope, rule);
  if (result.errors.length > 0) {
    context.ui.toast.show({ message: result.errors.join("; "), variant: "warning", duration: 7000 });
    return false;
  }
  context.ui.toast.show({
    message: `Saved nudge ${rule.scope}:${rule.id} · ${describeNudgeTrigger(rule)}`,
    variant: "success",
  });
  return true;
}

async function wizard(context: NudgeTuiContext, sessionID: string): Promise<void> {
  const preset = await context.ui.dialog.select<NudgePreset>({
    title: "Custom nudge preset",
    options: NUDGE_PRESETS.map((choice) => ({
      title: choice.title,
      value: choice.value,
      description: choice.description,
    })),
  });
  if (!preset) return;

  const scope = await context.ui.dialog.select<NudgeScope>({
    title: "Where should this rule live?",
    options: [
      { title: "Session", value: "session", description: "This session only (stored separately)" },
      { title: "Project", value: "project", description: "Every session in this project" },
      { title: "Global", value: "global", description: "Every session, in ~/.config/opencode" },
    ],
    current: "session",
  });
  if (!scope) return;

  const id = (
    await context.ui.dialog.prompt({
      title: "Rule id",
      description: "Slug used by on/off/clear, e.g. stale-build",
      placeholder: "stale-build",
    })
  )?.trim();
  if (!id) return;

  const text = (
    await context.ui.dialog.prompt({
      title: "Reminder text",
      description:
        "Model-facing. Placeholders: {id} {title} {status} {age} {count} {action}",
      placeholder: "{id} has been {status} for {age} — {action}",
    })
  )?.trim();
  if (!text) return;

  let every: string | undefined;
  if (preset === "custom") {
    every =
      (
        await context.ui.dialog.prompt({
          title: "Interval (blank for event-only)",
          description: "5m, 30s, 2h",
          placeholder: "5m",
        })
      )?.trim() || undefined;
  }

  const severity =
    preset === "block"
      ? "block"
      : ((await context.ui.dialog.select<"info" | "warn" | "block">({
          title: "Severity",
          options: [
            { title: "warn (context)", value: "warn" },
            { title: "info (context)", value: "info" },
            { title: "block (synthetic only if delivery is synthetic)", value: "block" },
          ],
          current: "warn",
        })) ?? "warn");

  const result = buildNudgeRule(
    {
      id,
      text,
      scope,
      severity,
      ...(every ? { trigger: { type: "interval", everyMs: every } } : {}),
      ...(preset === "custom" && !every ? { trigger: { type: "event" as const } } : {}),
      source: "user",
      createdAt: Date.now(),
    },
    preset,
    scope
  );
  if (!result.ok || !result.rule) {
    context.ui.toast.show({ message: result.errors.join("; "), variant: "warning", duration: 7000 });
    return;
  }
  const confirmed = await context.ui.dialog.confirm({
    title: "Save custom nudge?",
    message: [
      `${result.rule.scope}:${result.rule.id} · ${result.rule.severity} · ${result.rule.delivery}`,
      `${describeNudgeTrigger(result.rule)}; ${describeNudgeCriteria(result.rule)}`,
      `Text: ${result.rule.text}`,
    ].join("\n"),
  });
  if (!confirmed) return;
  await saveRule(context, sessionID, result.rule);
}

export async function runNudgeCommand(
  context: NudgeTuiContext,
  sessionID: string | undefined,
  rawArgs: string
): Promise<void> {
  const args = rawArgs.trim();
  if (!sessionID) {
    context.ui.toast.show({ message: "Open a session to manage custom nudges", variant: "warning" });
    return;
  }
  const sub = (args.split(/\s+/)[0] ?? "").toLowerCase();
  const rest = args.slice(sub.length).trim();

  if (!sub || sub === "wizard") {
    await wizard(context, sessionID);
    return;
  }
  if (sub === "list" || sub === "status") {
    await showList(context, sessionID, sub === "status" || rest.includes("--detailed"));
    return;
  }
  if (sub === "on") {
    await toggle(context, sessionID, rest, true, false);
    return;
  }
  if (sub === "off") {
    await toggle(context, sessionID, rest, false, false);
    return;
  }
  if (sub === "clear") {
    await toggle(context, sessionID, rest, false, true);
    return;
  }
  if (sub !== "set") {
    context.ui.toast.show({
      message: "Usage: /progress nudge [list|status|set|on|off|clear]",
      variant: "warning",
    });
    return;
  }

  const flags = parseFlags(rest);
  if (!flags.values.id || !flags.values.text) {
    await wizard(context, sessionID);
    return;
  }
  const scope: NudgeScope =
    flags.values.scope === "global" || flags.values.scope === "project"
      ? flags.values.scope
      : "session";
  const criteria: Record<string, unknown> = {};
  if (flags.values.status) criteria.statuses = flags.values.status.split(",").map((s) => s.trim());
  if (flags.values.stale) criteria.staleAfter = flags.values.stale;
  if (flags.values["no-progress"]) criteria.noProgressAfter = flags.values["no-progress"];
  if (flags.values["no-progress-steps"]) criteria.noProgressAfterSteps = Number(flags.values["no-progress-steps"]);
  if (flags.values["in-flight"]) criteria.inFlight = flags.values["in-flight"];
  if (flags.values.tree) criteria.tree = flags.values.tree;
  if (flags.booleans.has("idle")) criteria.idleOnly = true;
  if (flags.values.ids) criteria.entryIds = flags.values.ids.split(",").map((s) => s.trim());
  if (flags.values.sessions) criteria.sessions = flags.values.sessions;

  const every = flags.values.every;
  const steps = flags.values.steps ? Number(flags.values.steps) : undefined;
  const trigger = flags.booleans.has("event")
    ? { type: "event" as const }
    : every && steps
      ? { type: "either" as const, everyMs: parseNudgeDuration(every), everySteps: steps }
      : steps
        ? { type: "steps" as const, everySteps: steps }
        : every
          ? { type: "interval" as const, everyMs: parseNudgeDuration(every) }
          : undefined;

  const preset = (flags.values.preset as NudgePreset | undefined) ?? "custom";
  const result = buildNudgeRule(
    {
      id: flags.values.id,
      title: flags.values.title,
      text: flags.values.text,
      scope,
      severity: flags.values.severity,
      delivery: flags.values.delivery,
      trigger,
      cooldownMs: flags.values.cooldown,
      ttlMs: flags.values.ttl,
      maxFires: flags.booleans.has("one-shot") ? 1 : flags.values["max-fires"] ? Number(flags.values["max-fires"]) : undefined,
      criteria,
      source: "user",
      createdAt: Date.now(),
    },
    preset,
    scope
  );
  if (!result.ok || !result.rule) {
    context.ui.toast.show({ message: result.errors.join("; "), variant: "warning", duration: 7000 });
    return;
  }
  await saveRule(context, sessionID, result.rule);
}
