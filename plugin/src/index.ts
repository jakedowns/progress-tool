/**
 * OpenCode Progress Plugin — server part.
 *
 * Watches the shared progress state file written by the progress MCP server /
 * relay and exposes it to the TUI and GUI parts through RPC.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import { Plugin, Skill } from "@opencode/plugin";
import { ProgressRpc } from "./rpc.js";
import {
  adoptChildEntries,
  clearSayNotes,
  dismissSayNote,
  hardDeleteAll,
  hardDeleteSession,
  readProgressState,
  readSessionMap,
  recordChildSession,
  recordSayNote,
  rootSessionFor,
  sayNotesForSession,
  softClearSession,
  writeDismissal,
} from "./state.js";
import { readTaskListStatus, toggleTaskListMode } from "./tasklist-prefs.js";
import { normalizeRefreshMs } from "./tree.js";
import { writeThemeToConfig } from "./tree-theme.js";
import {
  PROGRESS_RULES,
  instructionsEnabled,
  sayRules,
  sessionAttributionRules,
} from "./instructions.js";
import {
  createSayController,
  normalizeSayOptions,
  type SayController,
} from "./say.js";
import {
  formatReminder,
  isHealthyWaiting,
  pickTarget,
  reminderGapAllows,
  reminderHash,
  shouldReplaceReminder,
  type ReminderSeverity,
  type ReminderState,
} from "./reminders.js";
import {
  clearNudgeRule,
  clearSessionNudgeRule,
  describeNudgeCriteria,
  describeNudgeTrigger,
  emptyNudgeRuntime,
  entriesForSessions,
  evaluateNudgeRule,
  formatNudgeDuration,
  mergeNudgeRules,
  nextNudgeFireAt,
  readNudgeRuleFile,
  readSessionNudgeRules,
  resolveNudgePaths,
  ruleRuntimeKey,
  ruleSuppressesBuiltins,
  setNudgeRuleEnabled,
  setSessionNudgeRuleEnabled,
  upsertNudgeRule,
  upsertSessionNudgeRule,
  buildNudgeRule,
  customNudgesEnabled,
  type CustomNudgeRule,
  type NudgeEntry,
  type NudgeRuntime,
  type NudgeScope,
} from "./custom-nudges.js";
import {
  decideSayNudge,
  emptySayNudgeState,
  normalizeSayNudgeOptions,
  recordSayNudge,
  type SayNudgeState,
} from "./say-monitor.js";
import {
  observeToolCall,
  normalizeStrictMode,
  normalizeStaleAfterMs,
  normalizeStaleCooldownMs,
  normalizeStaleEscalateAfter,
  normalizeWallClockMs,
  silentRunNudge,
  staleProgressNudge,
  staleProgressEscalation,
  idleReminder,
  wallClockNudge,
  relayCommandPattern,
  relayHintFor,
  relayHintMessage,
  relayPatternHintMessage,
  type MonitorState,
  type IdleTracker,
  type WallClockState,
} from "./monitor.js";
import { logNudge, nudgeLoggingEnabled, diffStatuses, type StatusSnapshot } from "./telemetry.js";
import { resolveMcpLaunch, taskListEnvironment } from "./mcp.js";
import { injectParentSession, isSubagentTool } from "./subagent.js";
import {
  PACKAGED_SKILLS,
  enabledSkills,
  loadPackagedSkillBody,
  skillPath,
} from "./skills.js";

/**
 * The plugin's own version, read at runtime so a running server part can be
 * identified in logs independently of the (separately loaded) GUI bundle.
 * The desktop app reloads GUI bundles on window reopen but only reloads this
 * server part on a service restart — logging the version makes that
 * split-brain visible ("GUI updated, server stale").
 */
const pluginVersion = (() => {
  try {
    return (
      JSON.parse(
        readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")
      ).version ?? "unknown"
    );
  } catch {
    return "unknown";
  }
})();

export default Plugin.define({
  id: "opencode-progress",
  async setup(ctx) {
    // Auto-register the MCP server from the published companion package so a
    // single `opencode plugin add` installs everything. A dev checkout that
    // loads this plugin by path won't resolve the package — skip silently.
    // Opt out with { options: { autoRegisterMcp: false } }.
    //
    // The interpreter must be a real JS runtime: `process.execPath` is the
    // `opencode` binary under OpenCode Desktop, and handing it the MCP
    // entrypoint makes it chdir into the `.js` file (ENOTDIR). Resolve
    // node/bun/npx instead; see src/mcp.ts and issue #1.
    if (ctx.options?.autoRegisterMcp !== false) {
      try {
        const requireFromHere = createRequire(import.meta.url);
        const mcpEntry = requireFromHere.resolve("@jakedowns/progress-tool-mcp");
        const launch = resolveMcpLaunch(mcpEntry, {
          runtime: typeof ctx.options?.mcpRuntime === "string" ? ctx.options.mcpRuntime : undefined,
        });
        if (!launch) {
          console.warn(
            `[opencode-progress] v${pluginVersion} progress-server NOT registered: no node/bun/npx found. ` +
              `Set { "options": { "mcpRuntime": "/absolute/path/to/node" } } or configure ` +
              `mcp.servers.progress-server manually with command ["npx", "-y", "@jakedowns/progress-tool-mcp"]`
          );
        } else {
          let registered = false;
          const taskListEnv = taskListEnvironment(ctx.options);
          await ctx.mcp.transform((editor) => {
            if (editor.get("progress-server")) return;
            editor.set("progress-server", {
              type: "local",
              command: launch.command,
              ...(taskListEnv ? { environment: taskListEnv } : {}),
            });
            registered = true;
          });
          if (registered) {
            console.log(
              `[opencode-progress] v${pluginVersion} registered progress-server (${launch.source}): ${launch.command.join(" ")}`
            );
          } else {
            console.log(
              `[opencode-progress] v${pluginVersion} progress-server already configured — leaving it as is`
            );
          }
        }
      } catch (error) {
        // Companion package not installed (local dev) — keep the existing config.
        if ((error as { code?: string } | undefined)?.code !== "MODULE_NOT_FOUND") {
          console.warn(`[opencode-progress] v${pluginVersion} progress-server auto-registration skipped: ${String(error)}`);
        }
      }
    }

    // Experimental `say` narration tool. Opt in with { options: { say: true } }.
    // It is a regular plugin tool, so the turn cannot end on a note; its result
    // always tells the model to keep working.
    const sayOptions = normalizeSayOptions(ctx.options);
    const sayNudgeOptions = normalizeSayNudgeOptions(ctx.options);
    const sayNudgeStates = new Map<string, SayNudgeState>();
    /** Non-say/progress tool calls this turn, reset by an accepted note/prompt. */
    const sayCallsSinceNote = new Map<string, number>();
    const toolStartedAt = new Map<string, number>();
    /** Model steps since the last progress write. */
    const stepsSinceProgress = new Map<string, number>();
    /** Active execute.before/after calls per session (parallel-safe). */
    const activeToolCounts = new Map<string, number>();
    /** Prompt-time baseline so resumed sessions do not print huge ages. */
    const promptAt = new Map<string, number>();
    /** One standing reminder entry per session. */
    const standingReminders = new Map<string, ReminderState>();
    const REMINDER_KEY = 'progress-reminder';
    /** Non-block reminders stay quiet for this long after any other reminder. */
    const reminderGapMs = (() => {
      const raw = ctx.options?.nudgeGapMs;
      return typeof raw === "number" && Number.isFinite(raw) && raw >= 0
        ? Math.min(15 * 60_000, Math.floor(raw))
        : 60_000;
    })();
    const lastReminderAt = new Map<string, number>();
    /** Agent-set snooze; non-block reminders only, so safety blocks still land. */
    const nudgeMutedUntil = new Map<string, number>();
    const reminderMuted = (sessionID: string): boolean =>
      (nudgeMutedUntil.get(sessionID) ?? 0) > Date.now();

    /** Descendant sessions (children, grandchildren) for a root session. */
    const descendantSessions = (sessionID: string): Set<string> => {
      const links = readSessionMap();
      const children = new Set<string>();
      let changed = true;
      while (changed) {
        changed = false;
        for (const [child, link] of Object.entries(links)) {
          if (!link?.parentID || children.has(child)) continue;
          if (link.parentID === sessionID || children.has(link.parentID)) {
            children.add(child);
            changed = true;
          }
        }
      }
      return children;
    };

    /** A parent blocked on live child work is not a stalled parent. */
    const hasActiveChildren = (
      sessionID: string,
      now: number,
      freshnessMs: number
    ): boolean => {
      const children = descendantSessions(sessionID);
      if (children.size === 0) return false;
      return Object.values(readProgressState().entries ?? {}).some(
        (entry) =>
          entry &&
          entry.sessionId &&
          children.has(entry.sessionId) &&
          (entry.status === 'running' || entry.status === 'waiting') &&
          !entry.dismissed &&
          (entry.updatedAt == null || now - entry.updatedAt < freshnessMs)
      );
    };

    // Custom nudge rules live in dedicated files (global/project/session),
    // never in opencode.json. The scheduler reads them on demand: the files
    // are tiny, and this keeps the TUI and server in sync without IPC.
    const customNudgesOn = customNudgesEnabled(ctx.options);
    const nudgePaths = resolveNudgePaths({ directory: ctx.location?.directory ?? process.cwd() });
    const nudgeRuntimes = new Map<string, NudgeRuntime>();
    const knownSessions = new Set<string>();
    const nudgeRuntimeFor = (
      rule: CustomNudgeRule,
      sessionID: string,
      now: number
    ): NudgeRuntime => {
      const key = ruleRuntimeKey(rule, sessionID);
      const current = nudgeRuntimes.get(key);
      if (current) return current;
      const runtime = emptyNudgeRuntime(rule, now);
      nudgeRuntimes.set(key, runtime);
      return runtime;
    };
    const effectiveNudgeRules = (sessionID: string) => {
      const global = readNudgeRuleFile(nudgePaths.globalFile, "global");
      const project = readNudgeRuleFile(nudgePaths.projectFile, "project");
      const session = readSessionNudgeRules(nudgePaths.sessionFile, sessionID);
      return {
        rules: mergeNudgeRules({
          global: global.rules,
          project: project.rules,
          session: session.rules,
        }),
        errors: [...global.errors, ...project.errors, ...session.errors],
      };
    };
    /** True while a replace rule is live; built-in reminders stay quiet. */
    const hasActiveReplace = (sessionID: string): boolean => {
      if (!customNudgesOn) return false;
      const now = Date.now();
      return effectiveNudgeRules(sessionID).rules.some((rule) =>
        ruleSuppressesBuiltins(rule, nudgeRuntimeFor(rule, sessionID, now), now)
      );
    };

    const putReminder = (
      sessionID: string,
      severity: ReminderSeverity,
      source: string,
      body: string
    ): boolean => {
      // Message helpers that already carry a tier prefix must not be wrapped
      // twice; helpers that return only a body get the prefix here.
      const isCustom = source.startsWith("custom:");
      const now = Date.now();
      if (severity !== "block" && reminderMuted(sessionID)) {
        if (verbose) logNudge({ event: 'reminder', sessionID, severity, source, suppressed: 'muted' });
        return false;
      }
      if (!isCustom && hasActiveReplace(sessionID)) {
        if (verbose) logNudge({ event: 'reminder', sessionID, severity, source, suppressed: 'custom-replace' });
        return false;
      }
      if (!reminderGapAllows(lastReminderAt.get(sessionID) ?? 0, now, reminderGapMs, severity)) {
        if (verbose) logNudge({ event: 'reminder', sessionID, severity, source, suppressed: 'gap' });
        return false;
      }
      const text = /^\[(info|warn|block)\]\s/.test(body)
        ? body.trim()
        : formatReminder(severity, body);
      const next: ReminderState = {
        severity,
        source,
        text,
        hash: reminderHash(text),
        at: Date.now(),
      };
      if (!shouldReplaceReminder(standingReminders.get(sessionID), next)) {
        if (verbose) logNudge({ event: 'reminder', sessionID, severity, source, text, deduped: true });
        return false;
      }
      standingReminders.set(sessionID, next);
      lastReminderAt.set(sessionID, now);
      void ctx.session.instructions.entry
        .put({ sessionID, key: REMINDER_KEY, value: text })
        .catch(() => {});
      if (verbose) logNudge({ event: 'reminder', sessionID, severity, source, text, deduped: false });
      return true;
    };

    const clearReminder = (sessionID: string, source?: string): void => {
      const current = standingReminders.get(sessionID);
      if (!current) return;
      if (source && current.source !== source) return;
      standingReminders.delete(sessionID);
      void ctx.session.instructions.entry
        .remove({ sessionID, key: REMINDER_KEY })
        .catch(() => {});
    };

    /**
     * Evaluate the session's effective custom rules (narrower scopes first).
     * Called on tool completion, at turn end, and on the interval timer.
     * `timer` limits the pass to clock-triggered rules so event rules do not
     * fire just because the timer ticked.
     */
    function evaluateCustomNudges(
      sessionID: string,
      options: { idle?: boolean; timer?: boolean } = {}
    ): void {
      if (!customNudgesOn) return;
      try {
        knownSessions.add(sessionID);
        const now = Date.now();
        const { rules } = effectiveNudgeRules(sessionID);
        if (rules.length === 0) return;
        const all = Object.entries(readProgressState().entries ?? {}).map(
          ([key, entry]) => ({ ...(entry as NudgeEntry), key })
        );
        const links = readSessionMap();
        const steps = stepsSinceProgress.get(sessionID) ?? 0;
        const inFlight = (activeToolCounts.get(sessionID) ?? 0) > 0;
        const seen = new Set<string>();
        for (const rule of rules) {
          if (
            options.timer &&
            rule.trigger.type !== "interval" &&
            rule.trigger.type !== "either"
          ) {
            continue;
          }
          const sessionMode = rule.criteria.sessions ?? "self";
          const scoped = entriesForSessions(all, sessionMode, sessionID, links);
          const scopedProgress = scoped.reduce(
            (max, entry) => Math.max(max, entry.updatedAt ?? 0),
            0
          );
          // The newest real signal; fall back to the prompt baseline so a
          // resumed session does not look stale from a previous day.
          const progressBase =
            scopedProgress > 0
              ? Math.max(scopedProgress, promptAt.get(sessionID) ?? 0)
              : promptAt.get(sessionID) ?? now;
          const runtime = nudgeRuntimeFor(rule, sessionID, now);
          const result = evaluateNudgeRule(rule, runtime, {
            now,
            entries: scoped,
            stepsSinceProgress: steps,
            lastProgressAt: progressBase,
            inFlight,
            idle: options.idle === true,
          });
          if (!result.fire || !result.text) {
            if (verbose && result.reason === "expired") {
              logNudge({
                event: "custom-nudge",
                sessionID,
                ruleId: rule.id,
                scope: rule.scope,
                reason: "expired",
              });
            }
            continue;
          }
          nudgeRuntimes.set(ruleRuntimeKey(rule, sessionID), result.runtime);
          if (seen.has(result.text)) {
            if (verbose) {
              logNudge({
                event: "custom-nudge",
                sessionID,
                ruleId: rule.id,
                scope: rule.scope,
                reason: "deduped",
              });
            }
            continue;
          }
          seen.add(result.text);
          const source = `custom:${rule.id}`;
          putReminder(sessionID, rule.severity, source, result.text);
          if (rule.delivery === "synthetic") {
            void ctx.session
              .synthetic({
                sessionID,
                text: formatReminder(rule.severity, result.text),
              })
              .catch(() => {});
          }
          if (verbose) {
            logNudge({
              event: "custom-nudge",
              sessionID,
              ruleId: rule.id,
              scope: rule.scope,
              severity: rule.severity,
              delivery: rule.delivery,
              text: result.text,
            });
          }
        }
      } catch (error) {
        console.error("[opencode-progress] custom nudge evaluation failed", String(error));
      }
    }

    let sayController: SayController | undefined;
    let sayToolName = "say";
    let sayRegistration: Awaited<ReturnType<typeof ctx.tool.transform>> | undefined;
    let sayPromptHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;
    let sayIdleHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;
    if (sayOptions.enabled) {
      try {
        const taken = new Set((await ctx.tool.list()).map((tool) => tool.id));
        sayToolName = taken.has("say") ? "progress_say" : "say";
        sayController = createSayController(
          sayOptions,
          {
            recordNote: (note) => {
              const link = readSessionMap()[note.sessionID];
              recordSayNote({
                sessionID: note.sessionID,
                text: note.text,
                kind: note.kind,
                eta: note.eta ?? null,
                agent: link?.agent ?? null,
                at: note.at,
              });
              // A real note is compliance: reset the forgot-to-narrate counter
              // and clear a say-sourced standing reminder.
              sayCallsSinceNote.set(note.sessionID, 0);
              clearReminder(note.sessionID, 'say');
            },
            synthetic: (input) =>
              hasActiveReplace(input.sessionID)
                ? Promise.resolve()
                : ctx.session.synthetic(input),
            log: (message, error) =>
              console.warn(`[opencode-progress] ${message}`, error ?? ""),
          },
          sayToolName
        );
        sayRegistration = await ctx.tool.transform((editor) => {
          editor.add(sayController!.tool as Parameters<typeof editor.add>[0]);
        });
        console.log(
          `[opencode-progress] v${pluginVersion} experimental say tool registered as ${sayToolName} ` +
            `(${sayOptions.minChars}–${sayOptions.maxChars} chars, ${sayOptions.budgetPerTurn}/turn)`
        );
      } catch (error) {
        console.warn(
          `[opencode-progress] v${pluginVersion} say tool registration failed: ${String(error)}`
        );
        sayController = undefined;
      }
    }

    // Whether the `progress` tool is actually present in the outgoing request.
    // A config entry is not proof the MCP server connected, and MCP connects
    // asynchronously, so inspect the model's tool set on every context hook.
    // This keeps guidance honest: no "call the progress tool" nudges when the
    // tool is unavailable (issue #1, related UX).
    const progressTool = { available: false, warned: false };
    const hasProgressTool = (tools: Record<string, unknown> | undefined): boolean =>
      Boolean(tools) &&
      Object.keys(tools ?? {}).some((name) => /(^|[_-])progress(_touch)?$/i.test(name));

    const stateSignature = (state: ReturnType<typeof readProgressState>) =>
      JSON.stringify([state.entries ?? {}, state.notes ?? {}]);
    let signature = stateSignature(readProgressState());

    const registration = await ctx.rpc.register(ProgressRpc, {
      list: async (input) => {
        const { sessionID, scope } = (input ?? {}) as {
          sessionID?: string;
          scope?: "session" | "all";
        };
        const state = readProgressState();
        const allEntries = state.entries ?? {};
        const entries: Record<string, any> = {};
        for (const [key, entry] of Object.entries(allEntries)) {
          if (!entry || typeof entry !== "object") continue;
          if (
            scope !== "all" &&
            sessionID &&
            entry.sessionId !== sessionID &&
            !key.startsWith(`${sessionID}:`)
          ) {
            continue;
          }
          entries[key] = entry;
        }
        const links = readSessionMap();
        const allNotes = Object.values(state.notes ?? {})
          .flatMap((list) => (Array.isArray(list) ? list : []))
          .sort((a, b) => (b.at ?? 0) - (a.at ?? 0));
        const selectedNotes =
          scope === "all"
            ? allNotes.slice(0, 200)
            : sayNotesForSession(state, sessionID, { links });
        const notes = selectedNotes.map((note) => {
          const wire: Record<string, unknown> = {
            id: note.id,
            sessionId: note.sessionId,
            rootSessionId: rootSessionFor(note.sessionId, links),
            text: note.text,
            kind: note.kind,
            at: note.at,
          };
          if (note.eta) wire.eta = note.eta;
          if (note.agent) wire.agent = note.agent;
          return wire;
        });
        let maxUpdated = 0;
        let cleared = 0;
        for (const entry of Object.values(entries)) {
          if (!entry || typeof entry !== "object") continue;
          maxUpdated = Math.max(
            maxUpdated,
            entry.updatedAt || 0,
            entry.dismissed?.at || 0,
            entry.cleared?.at || 0
          );
          if (entry.cleared) cleared++;
        }
        return {
          entries,
          notes,
          updatedAt: Date.now(),
          revision: `${Object.keys(entries).length}:${maxUpdated}:${cleared}:${allNotes.length}:${allNotes[0]?.at ?? 0}`,
        };
      },
      dismiss: async ({ key, status }) => {
        const ok = writeDismissal(key, status);
        console.log(`[opencode-progress] v${pluginVersion} dismiss rpc key=${key} status=${status} ok=${ok}`);
        return { ok };
      },
      dismissNote: async ({ noteID }) => {
        const ok = dismissSayNote(noteID);
        console.log(`[opencode-progress] v${pluginVersion} dismiss note rpc id=${noteID} ok=${ok}`);
        return { ok };
      },
      clearNotes: async ({ sessionID }) => {
        const removed = clearSayNotes(sessionID);
        console.log(
          `[opencode-progress] v${pluginVersion} clear notes rpc session=${sessionID} removed=${removed}`
        );
        return { ok: true, removed };
      },
      clear: async ({ sessionID }) => {
        const result = softClearSession(sessionID);
        return { ok: true, cleared: result.cleared };
      },
      hardClearSession: async ({ sessionID }) => {
        const result = hardDeleteSession(sessionID);
        return { ok: true, removed: result.removed, freedBytes: result.freedBytes };
      },
      hardClearAll: async () => {
        const result = hardDeleteAll();
        return { ok: true, removed: result.removed, freedBytes: result.freedBytes };
      },
      stats: async (input) => {
        const { sessionID } = (input ?? {}) as { sessionID?: string };
        const state = readProgressState();
        const scoped: Record<string, any> = {};
        for (const [key, entry] of Object.entries(state.entries ?? {})) {
          if (!entry || typeof entry !== "object") continue;
          if (
            sessionID &&
            entry.sessionId !== sessionID &&
            !key.startsWith(`${sessionID}:`)
          ) {
            continue;
          }
          scoped[key] = entry;
        }
        let active = 0;
        let done = 0;
        let error = 0;
        let dismissed = 0;
        let cleared = 0;
        for (const entry of Object.values(scoped)) {
          if (entry.cleared) {
            cleared++;
            continue;
          }
          if (entry.status === "running" || entry.status === "waiting") active++;
          if (entry.status === "done") done++;
          if (entry.status === "error") error++;
          if (entry.dismissed) dismissed++;
        }
        return {
          entries: Object.keys(scoped).length,
          active,
          done,
          error,
          dismissed,
          cleared,
          bytes: Buffer.byteLength(JSON.stringify(scoped)),
        };
      },
      taskListStatus: async () =>
        readTaskListStatus() ?? {
          enabled: false,
          mode: "ui",
          detail: "code",
          location: 1,
          order: "newest-first",
        },
      toggleTaskListMode: async () => {
        const mode = toggleTaskListMode();
        console.log(`[opencode-progress] v${pluginVersion} task-list mode=${mode}`);
        return { ok: true, mode };
      },
      nudgeList: async ({ sessionID }) => {
        if (!customNudgesOn) {
          return { rules: [], errors: ["custom nudges are disabled (set customNudges: true)"] };
        }
        const global = readNudgeRuleFile(nudgePaths.globalFile, "global");
        const project = readNudgeRuleFile(nudgePaths.projectFile, "project");
        const session = readSessionNudgeRules(nudgePaths.sessionFile, sessionID);
        const merged = mergeNudgeRules({
          global: global.rules,
          project: project.rules,
          session: session.rules,
        });
        const effective = new Set(merged.map((rule) => ruleRuntimeKey(rule, sessionID)));
        const now = Date.now();
        const rows = [
          ...global.rules.map((rule) => ({ rule, scope: "global" as const })),
          ...project.rules.map((rule) => ({ rule, scope: "project" as const })),
          ...session.rules.map((rule) => ({ rule, scope: "session" as const })),
        ].map(({ rule }) => {
          const runtime = nudgeRuntimeFor(rule, sessionID, now);
          const nextFireAt = nextNudgeFireAt(rule, runtime, now);
          return {
            id: rule.id,
            ...(rule.title ? { title: rule.title } : {}),
            scope: rule.scope,
            enabled: rule.enabled,
            text: rule.text,
            severity: rule.severity,
            delivery: rule.delivery,
            trigger: describeNudgeTrigger(rule),
            criteria: describeNudgeCriteria(rule),
            ttlMs: rule.ttlMs,
            maxFires: rule.maxFires,
            fires: runtime.fires,
            expiresAt: rule.ttlMs > 0 ? runtime.createdAt + rule.ttlMs : 0,
            nextFireAt: nextFireAt ?? 0,
            lastFiredAt: runtime.lastFiredAt,
            effective: effective.has(ruleRuntimeKey(rule, sessionID)),
          };
        });
        return {
          rules: rows,
          errors: [...global.errors, ...project.errors, ...session.errors],
        };
      },
      nudgeSet: async ({ sessionID, preset, rule }) => {
        if (!customNudgesOn) {
          return { ok: false, error: "custom nudges are disabled (set customNudges: true)", rule: {} };
        }
        const rawRule = (rule ?? {}) as Record<string, unknown>;
        const result = buildNudgeRule(
          { ...rawRule, source: rawRule.source ?? "user" },
          (preset ?? "custom") as "replace" | "alongside" | "block" | "custom",
          (rawRule.scope as NudgeScope) ?? "session"
        );
        if (!result.ok || !result.rule) {
          return { ok: false, error: result.errors.join("; "), rule: {} };
        }
        const scope = result.rule.scope;
        if (scope === "session") {
          const saved = upsertSessionNudgeRule(nudgePaths.sessionFile, sessionID, result.rule);
          if (saved.errors.length > 0) return { ok: false, error: saved.errors.join("; "), rule: {} };
        } else {
          const file = scope === "global" ? nudgePaths.globalFile : nudgePaths.projectFile;
          const saved = upsertNudgeRule(file, scope, result.rule);
          if (saved.errors.length > 0) return { ok: false, error: saved.errors.join("; "), rule: {} };
        }
        nudgeRuntimes.delete(ruleRuntimeKey(result.rule, sessionID));
        console.log(
          `[opencode-progress] v${pluginVersion} custom nudge set ${scope}:${result.rule.id}`
        );
        return {
          ok: true,
          rule: {
            id: result.rule.id,
            scope,
            severity: result.rule.severity,
            delivery: result.rule.delivery,
            trigger: describeNudgeTrigger(result.rule),
            criteria: describeNudgeCriteria(result.rule),
            text: result.rule.text,
            warnings: result.warnings,
          },
        };
      },
      nudgeSetEnabled: async ({ sessionID, scope, id, enabled }) => {
        if (!customNudgesOn) {
          return { ok: false, error: "custom nudges are disabled (set customNudges: true)" };
        }
        const result =
          scope === "session"
            ? setSessionNudgeRuleEnabled(nudgePaths.sessionFile, sessionID, id, enabled)
            : setNudgeRuleEnabled(
                scope === "global" ? nudgePaths.globalFile : nudgePaths.projectFile,
                scope,
                id,
                enabled
              );
        nudgeRuntimes.delete(`${sessionID}:${scope}:${id}`);
        return result.errors.length > 0
          ? { ok: false, error: result.errors.join("; ") }
          : { ok: true };
      },
      nudgeClear: async ({ sessionID, scope, id }) => {
        if (!customNudgesOn) {
          return { ok: false, error: "custom nudges are disabled (set customNudges: true)" };
        }
        const result =
          scope === "session"
            ? clearSessionNudgeRule(nudgePaths.sessionFile, sessionID, id)
            : clearNudgeRule(
                scope === "global" ? nudgePaths.globalFile : nudgePaths.projectFile,
                scope,
                id
              );
        nudgeRuntimes.delete(`${sessionID}:${scope}:${id}`);
        return result.errors.length > 0
          ? { ok: false, error: result.errors.join("; ") }
          : { ok: true };
      },
      setIndicatorStyle: async ({ indicatorStyle }) => {
        const directory = ctx.location?.directory;
        // A user preference should follow them across projects: write the
        // global config first, then fall back to the project entry only when
        // the plugin is not declared globally.
        let result = writeThemeToConfig(
          { indicatorStyle },
          { directory, globalOnly: true }
        );
        if (!result.ok) {
          result = writeThemeToConfig({ indicatorStyle }, { directory });
        }
        console.log(
          `[opencode-progress] v${pluginVersion} indicator style=${result.indicatorStyle ?? indicatorStyle} ` +
            (result.ok ? `saved to ${result.file}` : `config not updated: ${result.error}`)
        );
        return {
          ok: result.ok,
          indicatorStyle: result.indicatorStyle ?? indicatorStyle,
          file: result.file,
          error: result.error,
        };
      },
      setTreeTheme: async ({ theme, barStyle }) => {
        const result = writeThemeToConfig(
          { treeTheme: theme, barStyle },
          { directory: ctx.location.directory }
        );
        const summary = `${result.treeTheme ?? theme}/${result.barStyle ?? barStyle ?? "blocks"}`;
        console.log(
          `[opencode-progress] v${pluginVersion} tree theme=${summary} ` +
            (result.ok ? `saved to ${result.file}` : `config not updated: ${result.error}`)
        );
        return {
          ok: result.ok,
          theme: result.treeTheme ?? theme,
          barStyle: result.barStyle ?? barStyle,
          file: result.file,
          error: result.error,
        };
      },
    });

    const refreshMs = normalizeRefreshMs(ctx.options);
    const retainDeletedSessionProgress = ctx.options?.retainDeletedSessionProgress === true;

    const timer = setInterval(() => {
      const next = stateSignature(readProgressState());
      if (next === signature) return;
      signature = next;
      void registration.events.emit("updated", { updatedAt: Date.now() }).catch(() => {});
    }, refreshMs);

    // Inject the progress & relay rules into the agent loop's system
    // instructions so agents know about the out-of-band relay BEFORE their
    // first long-running command, not only from the `progress` tool response.
    // Opt out per project with `{ "options": { "injectInstructions": false } }`.
    //
    // Rules are only injected while the `progress` tool is actually in the
    // model's tool set: if the MCP server failed to start, telling the agent to
    // call a tool that doesn't exist just produces phantom tool calls.
    const strictMode = normalizeStrictMode(ctx.options);
    const staleAfterMs = normalizeStaleAfterMs(ctx.options);
    const staleCooldownMs = normalizeStaleCooldownMs(ctx.options);
    const staleEscalateAfter = normalizeStaleEscalateAfter(ctx.options);
    const strictThreshold =
      typeof ctx.options?.strictThreshold === 'number' && ctx.options.strictThreshold >= 2
        ? ctx.options.strictThreshold
        : 3;
    const verbose = nudgeLoggingEnabled(ctx.options);

    let rulesRegistration: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;
    if (instructionsEnabled(ctx.options) || strictMode !== 'off') {
      const injectRules = instructionsEnabled(ctx.options);
      rulesRegistration = await ctx.session.hook("context", async (event) => {
        const stepSessionID = (event as { sessionID?: string }).sessionID;
        if (stepSessionID) {
          stepsSinceProgress.set(
            stepSessionID,
            (stepsSinceProgress.get(stepSessionID) ?? 0) + 1
          );
        }
        let available = hasProgressTool(
          (event as unknown as { tools?: Record<string, unknown> }).tools
        );

        // Code Mode may expose MCP tools only through the `tools` namespace in
        // the prompt instead of as direct entries. Fall back to the registry,
        // which lists every registered tool regardless of how it is surfaced.
        if (!available) {
          try {
            available = (await ctx.tool.list()).some((tool) => /progress/i.test(tool.id));
          } catch {
            // Registry unavailable — treat the request's tool set as truth.
          }
        }
        progressTool.available = available;

        if (!progressTool.available) {
          if (!progressTool.warned) {
            progressTool.warned = true;
            console.warn(
              `[opencode-progress] v${pluginVersion} progress tool not available — skipping progress rule injection and strict nudges until progress-server connects`
            );
          }
        } else if (progressTool.warned) {
          progressTool.warned = false;
          console.log(`[opencode-progress] v${pluginVersion} progress tool available — guidance enabled`);
        }
        if (!injectRules) return;
        if (progressTool.available) {
          event.system.push({ type: "text", text: PROGRESS_RULES });
          const sessionID = (event as unknown as { sessionID?: string }).sessionID;
          if (sessionID) {
            event.system.push({ type: "text", text: sessionAttributionRules(sessionID) });
          }
        }
        // `say` is independent of the progress MCP server: keep its rules even
        // when progress-server has not connected yet.
        if (sayController) {
          event.system.push({ type: "text", text: sayRules(sayOptions, sayToolName) });
        }
      });
      if (injectRules) console.log("[opencode-progress] progress rules injected into system instructions");
    }

    // Register the usage + delegation skills by default; the demos are
    // dev-only and opt in with `{ "options": { "demoSkills": true } }`.
    // Disable everything with `{ "options": { "registerSkills": false } }`.
    if (ctx.options?.registerSkills !== false) {
      const enabled = enabledSkills(ctx.options ?? {});
      await ctx.skill.transform((editor) => {
        for (const skill of enabled) {
          editor.add({
            id: Skill.ID.make(skill.id),
            name: Skill.Name.make(skill.name),
            description: skill.description,
            path: Skill.Info.fields.path.make(skillPath(skill)),
            content: loadPackagedSkillBody(skill),
            autoinvoke: true,
          });
        }
      });
      console.log(
        `[opencode-progress] v${pluginVersion} registered ${enabled.length}/${PACKAGED_SKILLS.length} packaged skills${ctx.options?.demoSkills === true ? " (demos on)" : ""}`
      );
    }

    // Strict mode: watch tool calls and nudge when the agent works silently
    // (no task entry) or leaves pending tasks' progress unchanged.
    const monitors = new Map<string, MonitorState>();

    // Behaviour telemetry: compare every observed store snapshot against the
    // previous one so we can measure how agents drive the lifecycle
    // (null→running start, running→running repeat, running→done finish,
    // done→running reopen, running→waiting pause).
    const statusSnapshots = new Map<string, StatusSnapshot>();
    const observeTransitions = (
      sessionID: string,
      entries: ReadonlyArray<{ id: string; status: string }>
    ) => {
      if (!verbose) return;
      const prev = statusSnapshots.get(sessionID) ?? {};
      const { transitions, next } = diffStatuses(prev, entries);
      statusSnapshots.set(sessionID, next);
      for (const transition of transitions) {
        logNudge({
          event: 'transition',
          sessionID,
          id: transition.id,
          from: transition.from,
          to: transition.to,
        });
      }
    };
    const lastSeenProgress = new Map<string, number>();
    let promptReminderHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;
    let promptResetHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;

    let toolHook: Awaited<ReturnType<typeof ctx.tool.hook>> | undefined;
    if (strictMode !== 'off') {
      toolHook = await ctx.tool.hook('execute.after', (event) => {
        try {
          // Guidance is only meaningful when the progress tool exists; the
          // context hook flips this on once the MCP server has connected.
          if (!progressTool.available) return;
          knownSessions.add(event.sessionID);
          const isProgressCall = /(^|_)progress(_touch)?$/.test(event.tool);
          const now = Date.now();
          const entries = Object.values(readProgressState().entries ?? {}).filter(
            (entry) => entry && entry.sessionId === event.sessionID
          );
          // Healthy waiting still counts as open work (so the silent-run path
          // does not fire), but it must not reset the staleness clock: only
          // real progress or a stale/detail-less entry should.
          const hasActive = entries.some(
            (entry) =>
              (entry.status === 'running' || entry.status === 'waiting') &&
              !entry.dismissed
          );
          const lastProgressAt = entries.reduce(
            (max, entry) =>
              entry.dismissed || isHealthyWaiting(entry, now, staleAfterMs)
                ? max
                : Math.max(max, entry.updatedAt ?? 0),
            0
          );

          const previousSeen = lastSeenProgress.get(event.sessionID) ?? 0;
          const progressAdvanced = lastProgressAt > previousSeen;
          if (lastProgressAt > previousSeen) lastSeenProgress.set(event.sessionID, lastProgressAt);
          if (isProgressCall || progressAdvanced) {
            stepsSinceProgress.set(event.sessionID, 0);
            clearReminder(event.sessionID);
          }
          const target = pickTarget(entries, now);
          if (hasActive && hasActiveChildren(event.sessionID, now, staleAfterMs)) {
            monitors.delete(event.sessionID);
            clearReminder(event.sessionID, 'strict');
            observeTransitions(event.sessionID, entries);
            return;
          }
          observeTransitions(event.sessionID, entries);

          const monitor = monitors.get(event.sessionID) ?? {
            count: 0,
            callsSinceProgress: 0,
            nudged: false,
            forced: false,
            lastStaleNudgeAt: 0,
            staleNudges: 0,
            escalated: false,
            nudgedAt: 0,
          };
          const wasNudged = monitor.nudged;
          const priorNudgedAt = monitor.nudgedAt;
          const priorStaleNudges = monitor.staleNudges;
          const priorEscalated = monitor.escalated;
          const step = observeToolCall(
            monitor,
            {
              isProgressCall,
              hasActive,
              lastProgressAt: lastProgressAt || undefined,
              progressAdvanced,
              now,
              stepsSinceProgress: stepsSinceProgress.get(event.sessionID) ?? 0,
            },
            { strictMode, staleAfterMs, cooldownMs: staleCooldownMs, threshold: strictThreshold, staleEscalateAfter }
          );

          monitor.count = step.count;
          monitor.callsSinceProgress = step.callsSinceProgress;
          monitor.lastStaleNudgeAt = step.lastStaleNudgeAt;
          monitor.staleNudges = step.staleNudges;
          monitor.escalated = step.escalated;
          monitor.nudgedAt = step.nudgedAt;
          if (
            step.action === 'nudge' ||
            step.action === 'force' ||
            step.action === 'stale-nudge' ||
            step.action === 'stale-escalate'
          ) {
            monitor.nudged = true;
          }
          if (step.action === 'force') monitor.forced = true;
          if (step.action === 'clear') monitor.nudged = false;
          monitors.set(event.sessionID, monitor);

          if (verbose && step.action !== 'none') {
            const now = Date.now();
            if (step.action === 'clear') {
              logNudge({
                event: 'compliance',
                sessionID: event.sessionID,
                afterMs: priorNudgedAt ? Math.max(0, now - priorNudgedAt) : null,
                staleNudges: priorStaleNudges,
                escalated: priorEscalated,
              });
            } else {
              logNudge({
                event: 'strict',
                action: step.action,
                sessionID: event.sessionID,
                count: step.count,
                callsSinceProgress: step.callsSinceProgress,
                staleNudges: step.staleNudges,
                escalated: step.escalated,
                priorNudged: wasNudged,
              });
            }
          }
          if (verbose && event.status === 'completed') {
            const resultText = JSON.stringify(event.result ?? '');
            if (resultText.includes('INVALID USAGE')) {
              logNudge({ event: 'child-list-error', sessionID: event.sessionID, tool: event.tool });
            }
          }

          const text =
            step.action === 'stale-escalate' ||
            (step.action === 'stale-nudge' && step.escalated)
              ? staleProgressEscalation(step.callsSinceProgress, step.staleNudges, target)
              : step.action === 'stale-nudge'
                ? staleProgressNudge(step.callsSinceProgress, target)
                : silentRunNudge(step.count, target, step.action === 'force' ? 'block' : 'warn');

          if (step.action === 'nudge' || step.action === 'stale-nudge') {
            putReminder(event.sessionID, 'warn', 'strict', text);
          }
          if (step.action === 'force' || step.action === 'stale-escalate') {
            clearReminder(event.sessionID, 'strict');
            if (!hasActiveReplace(event.sessionID)) {
              void ctx.session
                .synthetic({ sessionID: event.sessionID, text })
                .catch(() => {});
            }
          }
          if (step.action === 'clear') {
            clearReminder(event.sessionID, 'strict');
          }
        } catch (error) {
          console.error('[opencode-progress] strict-mode monitor failed', String(error));
        }
      });
      console.log(`[opencode-progress] v${pluginVersion} strict mode: ${strictMode} (threshold ${strictThreshold}, gated on progress tool availability)`);
    if (verbose) {
      logNudge({ event: "config", strictMode, strictThreshold, staleEscalateAfter, staleCooldownMs, wallClockMs: normalizeWallClockMs(ctx.options), idleReminder: ctx.options?.idleReminder !== false, unhinged: ctx.options?.unhinged === true });
    }
    }

    // Subagent attribution, part 1: `session.created` carries parentID the
    // moment a child session exists, so map (and adopt) before the child's
    // first progress call. `session.deleted` recycles the plugin store for
    // that session unless the user opted into retaining deleted sessions.
    // Consumed in the background; the stream ends when the plugin unloads.
    if (ctx.event?.subscribe) void (async () => {
      try {
        for await (const event of ctx.event.subscribe({
          types: ['session.created', 'session.deleted'],
        })) {
          if (event.type === 'session.created') {
            const child = event.data.sessionID;
            const parent = event.data.parentID;
            const agent = event.data.agent;
            const name =
              typeof event.data.title === "string" && event.data.title.trim()
                ? event.data.title.trim()
                : undefined;
            if (!child || !parent) continue;
            if (recordChildSession(child, parent, agent, name)) {
              adoptChildEntries(child, parent, agent, name);
            }
          } else if (event.type === 'session.deleted') {
            const deletedID = event.data.sessionID;
            knownSessions.delete(deletedID);
            for (const key of nudgeRuntimes.keys()) {
              if (key.startsWith(`${deletedID}:`)) nudgeRuntimes.delete(key);
            }
            if (retainDeletedSessionProgress) continue;
            const result = hardDeleteSession(deletedID);
            if (result.removed > 0) {
              console.log(
                `[opencode-progress] purged ${result.removed} entries for deleted session ${event.data.sessionID}`
              );
            }
          }
        }
      } catch (error) {
        console.error('[opencode-progress] session event subscription failed', String(error));
      }
    })();

    // Subagent attribution, part 2 (fallback): stamp the parent session id
    // into the child's task prompt. Even a child whose map link is missing
    // then reports under the session the user is watching. The injected
    // attribution rules explain that a prompt-supplied id wins.
    await ctx.tool.hook('execute.before', (event) => {
      if (!isSubagentTool(event.tool)) return;
      if (!progressTool.available) return;
      injectParentSession(event.input, event.sessionID);
    });

    // Idle reminder: at turn end (session about to go idle) with open,
    // non-dismissed entries, admit ONE synthetic message — it runs in the
    // same execution instead of the session going idle, so the model gets a
    // turn-end reminder ("you have a tree of todos pending"). Debounced by
    // entry signature + cooldown + per-run cap (monitor.ts).
    const idleTrackers = new Map<string, IdleTracker>();
    const idleReminderEnabled = ctx.options?.idleReminder !== false;
    const idleStaleMs =
      typeof ctx.options?.idleStaleMs === 'number' &&
      Number.isFinite(ctx.options.idleStaleMs) &&
      ctx.options.idleStaleMs >= 60_000
        ? Math.min(24 * 60 * 60_000, Math.floor(ctx.options.idleStaleMs))
        : 10 * 60_000;
    let idleHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;
    if (idleReminderEnabled) {
      idleHook = await ctx.session.hook('experimental.idle', async (event) => {
        try {
          knownSessions.add(event.sessionID);
          evaluateCustomNudges(event.sessionID, { idle: true });
          const entries = Object.values(readProgressState().entries ?? {}).filter(
            (entry) => entry && entry.sessionId === event.sessionID
          );
          const tracker = idleTrackers.get(event.sessionID) ?? { signature: '', lastAt: 0, count: 0 };
          const decision = idleReminder(tracker, entries, { now: Date.now(), staleAfterMs: idleStaleMs });
          idleTrackers.set(event.sessionID, {
            signature: decision.signature,
            lastAt: decision.lastAt,
            count: decision.count,
          });
          if (decision.action !== 'remind' || !decision.message) return;
          console.log(`[opencode-progress] v${pluginVersion} idle reminder (${decision.count}) for ${event.sessionID}`);
          if (verbose) {
            logNudge({ event: 'idle-reminder', sessionID: event.sessionID, count: decision.count, openEntries: decision.signature.split(' | ').filter(Boolean).length });
          }
          if (!hasActiveReplace(event.sessionID)) {
            await ctx.session.synthetic({ sessionID: event.sessionID, text: decision.message });
          }
        } catch (error) {
          console.error('[opencode-progress] idle reminder failed', String(error));
        }

      });
    }

    // `say` turn lifecycle: a new user prompt starts a fresh note budget, and
    // the final guard resumes once if the agent posted a note and then stopped
    // without a conclusion.
    if (sayController) {
      sayPromptHook = await ctx.session.hook("prompt", (event) => {
        const sessionID = (event as { sessionID?: string }).sessionID;
        if (sessionID) {
          sayController?.reset(sessionID);
          const previous = sayNudgeStates.get(sessionID);
          sayNudgeStates.set(sessionID, {
            lastNudgeAt: previous?.lastNudgeAt ?? 0,
            nudgesThisTurn: 0,
          });
          sayCallsSinceNote.set(sessionID, 0);
          clearReminder(sessionID, 'say');
        }
      });

      if (sayOptions.finalGuard) {
        sayIdleHook = await ctx.session.hook("experimental.idle", async (event) => {
          const state = sayController?.get(event.sessionID);
          if (!state?.accepted || state.guarded) return;

          // Only resume when the turn really has no assistant text. A note
          // followed by a normal answer must not trigger another turn.
          let hasText = false;
          try {
            const messages = await ctx.session.context({ sessionID: event.sessionID });
            const lastAssistant = [...messages]
              .reverse()
              .find((message) => (message as { type?: string }).type === "assistant");
            const content =
              (lastAssistant as
                | { content?: Array<{ type?: string; text?: string }> }
                | undefined)?.content ?? [];
            hasText = content.some(
              (part) => part.type === "text" && String(part.text ?? "").trim().length > 0
            );
          } catch (error) {
            return; // cannot verify the transcript — do not guess
          }
          if (hasText) return;

          sayController?.markGuarded(event.sessionID);
          try {
            await ctx.session.synthetic({
              sessionID: event.sessionID,
              text: "You posted a `say` note but did not conclude. Continue the task or give the final answer; do not post another note this turn.",
            });
            console.log(
              `[opencode-progress] v${pluginVersion} say final guard fired for ${event.sessionID}`
            );
          } catch (error) {
            console.warn("[opencode-progress] say final guard failed", error);
          }
        });
      }
    }

    // Opt-in say nudges: after a long tool OR a run of silent tool calls with
    // no narration this turn, leave a one-shot context hint for the NEXT step.
    // A nudge cannot reach the model while the tool is still running, so this
    // is deliberately retrospective and never a synthetic message. Gated on
    // `say: true`: a disabled say must never be nudged about.
    let sayNudgeBeforeHook: Awaited<ReturnType<typeof ctx.tool.hook>> | undefined;
    let sayNudgeAfterHook: Awaited<ReturnType<typeof ctx.tool.hook>> | undefined;
    if (sayOptions.enabled && sayController && sayNudgeOptions.mode !== 'off') {
      sayNudgeBeforeHook = await ctx.tool.hook('execute.before', (event) => {
        toolStartedAt.set(String(event.id), Date.now());
      });
      sayNudgeAfterHook = await ctx.tool.hook('execute.after', (event) => {
        try {
          if (event.tool === sayToolName || /(^|_)progress(_touch)?$/.test(event.tool)) return;
          const callsSinceSay = (sayCallsSinceNote.get(event.sessionID) ?? 0) + 1;
          sayCallsSinceNote.set(event.sessionID, callsSinceSay);
          const started = toolStartedAt.get(String(event.id));
          toolStartedAt.delete(String(event.id));
          const now = Date.now();
          const durationMs = started === undefined ? 0 : now - started;
          const controller = sayController?.get(event.sessionID);
          const state = sayNudgeStates.get(event.sessionID) ?? emptySayNudgeState();
          const decision = decideSayNudge(
            state,
            {
              sessionID: event.sessionID,
              tool: event.tool,
              durationMs,
              callsSinceSay,
              saidThisTurn: controller?.accepted === true,
              sayCount: controller?.count ?? 0,
              sayBudget: sayOptions.budgetPerTurn,
              progressNudgeActive: Boolean(standingReminders.get(event.sessionID)),
              now,
            },
            sayNudgeOptions
          );
          if (!decision.nudge || !decision.message) return;
          sayNudgeStates.set(event.sessionID, recordSayNudge(state, now));
          putReminder(event.sessionID, 'warn', 'say', decision.message);
          if (verbose) {
            logNudge({
              event: 'say-nudge',
              sessionID: event.sessionID,
              tool: event.tool,
              durationMs,
              callsSinceSay,
              reason: decision.reason,
            });
          }
        } catch (error) {
          console.warn('[opencode-progress] say nudge failed', String(error));
        }
      });
      if (verbose) {
        logNudge({
          event: 'config',
          sayNudge: sayNudgeOptions.mode,
          sayNudgeAfterMs: sayNudgeOptions.afterMs,
          sayNudgeMinCalls: sayNudgeOptions.minCalls,
          sayNudgeCooldownMs: sayNudgeOptions.cooldownMs,
          sayNudgeMaxPerTurn: sayNudgeOptions.maxPerTurn,
        });
      }
      console.log(
        `[opencode-progress] v${pluginVersion} say nudge: ${sayNudgeOptions.mode} ` +
          `(after ${sayNudgeOptions.afterMs}ms or ${sayNudgeOptions.minCalls} calls)`
      );
    }

    // "Unhinged" mode (opt-in): append a progress reminder to every user
    // message so the agent re-checks its task list whenever the workload
    // changes. Off by default — it edits user input text.
    if (ctx.options?.unhinged === true) {
      const promptHook = await ctx.session.hook('prompt', (event) => {
        event.prompt.text = `${event.prompt.text}\n\n[did the user's message just change your workload? if so, update the task tree with the \`progress\` tool (progress-server MCP) — not todowrite.]`;
        if (verbose) logNudge({ event: 'unhinged', sessionID: (event as { sessionID?: string }).sessionID });
      });
      promptReminderHook = promptHook;
      console.log(`[opencode-progress] v${pluginVersion} unhinged mode: prompt suffix enabled`);
    }

    // Wall-clock nudge: the call-count monitor cannot fire while an agent is
    // blocked (no tool calls ⇒ no events). A 30s timer evaluates every
    // session with pending entries and, after wallClockMs (default 10m) with
    // no progress write, writes a standing instruction — removed again as
    // soon as progress resumes.
    // Agent-facing nudge control. Registered as a plugin tool (not MCP) so it
    // shares the server's runtime state. Session scope only:
    // broader scopes change every session, and this host exposes no
    // permission prompt from the tool surface, so they are refused with a
    // pointer to the slash/palette surfaces.
    const nudgeRows = (sessionID: string) => {
      const global = readNudgeRuleFile(nudgePaths.globalFile, "global");
      const project = readNudgeRuleFile(nudgePaths.projectFile, "project");
      const session = readSessionNudgeRules(nudgePaths.sessionFile, sessionID);
      const merged = mergeNudgeRules({
        global: global.rules,
        project: project.rules,
        session: session.rules,
      });
      const effective = new Set(merged.map((rule) => ruleRuntimeKey(rule, sessionID)));
      const now = Date.now();
      return {
        rows: [
          ...global.rules.map((rule) => ({ rule })),
          ...project.rules.map((rule) => ({ rule })),
          ...session.rules.map((rule) => ({ rule })),
        ].map(({ rule }) => {
          const runtime = nudgeRuntimeFor(rule, sessionID, now);
          const next = nextNudgeFireAt(rule, runtime, now);
          return {
            rule,
            runtime,
            next,
            effective: effective.has(ruleRuntimeKey(rule, sessionID)),
          };
        }),
        errors: [...global.errors, ...project.errors, ...session.errors],
      };
    };

    const nudgeText = (sessionID: string, detailed: boolean): string => {
      const { rows, errors } = nudgeRows(sessionID);
      if (rows.length === 0) {
        return "No custom nudge rules. Set one with action \"set\" (session scope) or /progress nudge.";
      }
      const lines = rows.map(({ rule, runtime, next, effective }) => {
        const state = rule.enabled
          ? effective
            ? "on"
            : "muted"
          : "off";
        const base = `${rule.scope}:${rule.id} [${state}] ${rule.text}`;
        if (!detailed) return base;
        const bits = [
          base,
          `  ${describeNudgeTrigger(rule)}; ${describeNudgeCriteria(rule)}`,
          `  severity ${rule.severity}, ${rule.delivery}, cooldown ${formatNudgeDuration(rule.cooldownMs)}, ttl ${formatNudgeDuration(rule.ttlMs)}, fires ${runtime.fires}${rule.maxFires > 0 ? `/${rule.maxFires}` : ""}`,
        ];
        if (next != null) bits.push(`  next ${new Date(next).toISOString()}`);
        return bits.join("\n");
      });
      if (errors.length > 0) lines.push(`Invalid rules: ${errors.join("; ")}`);
      return lines.join("\n");
    };

    try {
      const taken = new Set((await ctx.tool.list()).map((tool) => tool.id));
      const nudgeToolName = taken.has("progress_nudge") ? "custom_progress_nudge" : "progress_nudge";
      await ctx.tool.transform((editor) => {
        editor.add({
          name: nudgeToolName,
          description:
            "Manage reminders for THIS session. Actions mute/unmute/status work always: mute non-block reminders (say, stale progress, wall-clock, relay hints, custom info/warn) for a number of minutes; block-level safety reminders still land. When customNudges is enabled, set/list/status/on/off/clear also manage configurable nudge rules (text, trigger, cooldown, criteria, TTL, fire cap). Agent-set rules are session-scoped only; project/global rules require the user-facing surfaces.",
          input: {
            type: "object",
            properties: {
              action: {
                type: "string",
                enum: ["mute", "unmute", "set", "list", "status", "on", "off", "clear"],
                description: "What to do. Defaults to list.",
              },
              minutes: {
                type: "number",
                description: "For mute: how long to quiet non-block reminders (1-240, default 30).",
              },
              preset: {
                type: "string",
                enum: ["replace", "alongside", "block", "custom"],
                description: "Preset for set: replace built-ins, alongside, synthetic block, or custom.",
              },
              id: { type: "string", description: "Rule id slug (required for on/off/clear/set)." },
              title: { type: "string", description: "Optional human-readable title." },
              text: {
                type: "string",
                description:
                  "Reminder text. Supports {id}, {title}, {status}, {age}, {count}, {action}; max 240 chars.",
              },
              severity: { type: "string", enum: ["info", "warn", "block"] },
              scope: {
                type: "string",
                enum: ["session"],
                description: "Agent rules are session-scoped only.",
              },
              delivery: {
                type: "string",
                enum: ["context-replace", "context-alongside", "synthetic"],
                description: "context-replace pauses built-ins while active; synthetic requires block.",
              },
              every: { type: "string", description: "Interval trigger, e.g. 5m or 30s." },
              steps: { type: "number", description: "Step trigger (model steps), e.g. 3." },
              eventOnly: {
                type: "boolean",
                description: "Event-only trigger: evaluate on tool/idle events, gated by cooldown.",
              },
              cooldown: { type: "string", description: "Minimum gap between fires, e.g. 2m." },
              ttl: { type: "string", description: "Lifetime, e.g. 1h. Defaults to 1h." },
              maxFires: { type: "number", description: "0 = unlimited, 1 = one-shot." },
              oneShot: { type: "boolean", description: "Convenience for maxFires: 1." },
              statuses: {
                type: "array",
                items: { type: "string", enum: ["pending", "running", "waiting", "done", "error"] },
                description: "Only entries with one of these statuses.",
              },
              staleAfter: { type: "string", description: "Only entries untouched longer than this, e.g. 10m." },
              noProgressAfter: { type: "string", description: "Only when no progress write for this long." },
              noProgressAfterSteps: { type: "number" },
              inFlight: { type: "string", enum: ["only", "never", "any"] },
              tree: { type: "string", enum: ["empty", "nonempty"] },
              idleOnly: { type: "boolean", description: "Evaluate only at turn end." },
              entryIds: { type: "array", items: { type: "string" } },
              sessions: { type: "string", enum: ["self", "children", "all"] },
            },
            required: [],
            additionalProperties: false,
          },
          options: { codemode: true },
          execute: async (input: Record<string, unknown>, context: { sessionID: string }) => {
            const sessionID = context.sessionID;
            knownSessions.add(sessionID);
            const action = String(input?.action ?? "list");
            if (action === "mute" || action === "unmute") {
              if (action === "unmute") {
                nudgeMutedUntil.delete(sessionID);
                return { content: "Session reminders unmuted." };
              }
              const raw = Number(input?.minutes);
              const minutes =
                Number.isFinite(raw) && raw > 0 ? Math.min(240, Math.max(1, Math.floor(raw))) : 30;
              nudgeMutedUntil.set(sessionID, Date.now() + minutes * 60_000);
              return {
                content:
                  `Session reminders muted for ${minutes}m (non-block only). ` +
                  "Block-level safety reminders still land; run this tool with action \"unmute\" to restore.",
              };
            }
            if (action === "status") {
              const remaining = Math.max(
                0,
                (nudgeMutedUntil.get(sessionID) ?? 0) - Date.now()
              );
              const muteLine =
                remaining > 0
                  ? `Muted for another ${Math.ceil(remaining / 60_000)}m.`
                  : "Not muted.";
              if (!customNudgesOn) {
                return {
                  content:
                    `${muteLine} Custom nudge rule editor is disabled (set customNudges: true); ` +
                    "mute/unmute still work.",
                };
              }
              return { content: `${muteLine}\n${nudgeText(sessionID, true)}` };
            }
            if (action === "list") {
              if (!customNudgesOn) {
                return {
                  content:
                    "Custom nudge rules are disabled (set customNudges: true). " +
                    "Mute is available: { action: \"mute\", minutes: 30 }.",
                };
              }
              return { content: nudgeText(sessionID, false) };
            }
            if (!customNudgesOn) {
              return {
                content:
                  "Custom nudge rules are disabled (set customNudges: true). " +
                  "Mute is available now: { action: \"mute\", minutes: 30 }.",
              };
            }
            const id = String(input?.id ?? "").trim();
            if (!id) return { content: "Missing id." };
            if (action === "on" || action === "off") {
              const result = setSessionNudgeRuleEnabled(
                nudgePaths.sessionFile,
                sessionID,
                id,
                action === "on"
              );
              nudgeRuntimes.delete(`${sessionID}:session:${id}`);
              return {
                content:
                  result.errors.length > 0
                    ? result.errors.join("; ")
                    : `Custom nudge session:${id} ${action === "on" ? "enabled" : "disabled"}.`,
              };
            }
            if (action === "clear") {
              clearSessionNudgeRule(nudgePaths.sessionFile, sessionID, id);
              nudgeRuntimes.delete(`${sessionID}:session:${id}`);
              return { content: `Custom nudge session:${id} cleared.` };
            }
            if (action !== "set") return { content: `Unknown action: ${action}` };
            const requestedScope = String(input?.scope ?? "session");
            if (requestedScope !== "session") {
              return {
                content:
                  `Refused: agent rules are session-scoped. ${requestedScope} rules affect every session, ` +
                  "and this tool surface cannot show a host permission prompt. Ask the user to create it " +
                  "with /progress nudge, the palette command, or the progress-nudge.json file.",
              };
            }
            const criteria: Record<string, unknown> = {};
            for (const key of [
              "statuses",
              "staleAfter",
              "noProgressAfter",
              "noProgressAfterSteps",
              "inFlight",
              "tree",
              "idleOnly",
              "entryIds",
              "sessions",
            ]) {
              if (input?.[key] !== undefined) criteria[key] = input[key];
            }
            let trigger: Record<string, unknown> | undefined;
            const every = input?.every;
            const steps = input?.steps;
            if (input?.eventOnly === true) {
              trigger = { type: "event" };
            } else if (every !== undefined && steps !== undefined) {
              trigger = { type: "either", everyMs: every, everySteps: steps };
            } else if (steps !== undefined) {
              trigger = { type: "steps", everySteps: steps };
            } else if (every !== undefined) {
              trigger = { type: "interval", everyMs: every };
            }
            const result = buildNudgeRule(
              {
                id,
                title: input?.title,
                text: input?.text,
                severity: input?.severity,
                delivery: input?.delivery,
                trigger,
                cooldownMs: input?.cooldown,
                ttlMs: input?.ttl,
                maxFires: input?.oneShot === true ? 1 : input?.maxFires,
                criteria,
                scope: "session",
                source: "agent",
                createdAt: Date.now(),
              },
              (input?.preset as string as any) ?? "custom",
              "session"
            );
            if (!result.ok || !result.rule) {
              return { content: `Not saved: ${result.errors.join("; ")}` };
            }
            const saved = upsertSessionNudgeRule(nudgePaths.sessionFile, sessionID, result.rule);
            if (saved.errors.length > 0) {
              return { content: `Not saved: ${saved.errors.join("; ")}` };
            }
            nudgeRuntimes.delete(ruleRuntimeKey(result.rule, sessionID));
            const warning = result.warnings.length > 0 ? ` (${result.warnings.join("; ")})` : "";
            return {
              content:
                `Saved session:${result.rule.id}${warning}. ${describeNudgeTrigger(result.rule)}; ` +
                `${describeNudgeCriteria(result.rule)}; delivery ${result.rule.delivery}. ` +
                `Model-facing text: "${result.rule.text}".`,
            };
          },
        } as Parameters<typeof editor.add>[0]);
      });
      console.log(`[opencode-progress] v${pluginVersion} custom nudge tool registered as ${nudgeToolName}`);
    } catch (error) {
      console.warn(`[opencode-progress] custom nudge tool registration failed: ${String(error)}`);
    }

    const wallClockMs = normalizeWallClockMs(ctx.options);
    const wallTrackers = new Map<string, WallClockState>();
    const lastToolCallAt = new Map<string, number>();

    promptResetHook = await ctx.session.hook("prompt", (event) => {
      const sessionID = (event as { sessionID?: string }).sessionID;
      if (!sessionID) return;
      knownSessions.add(sessionID);
      const now = Date.now();
      monitors.delete(sessionID);
      wallTrackers.delete(sessionID);
      idleTrackers.delete(sessionID);
      lastSeenProgress.delete(sessionID);
      stepsSinceProgress.set(sessionID, 0);
      promptAt.set(sessionID, now);
      lastToolCallAt.set(sessionID, now);
      activeToolCounts.delete(sessionID);
      sayCallsSinceNote.set(sessionID, 0);
      standingReminders.delete(sessionID);
      void ctx.session.instructions.entry
        .remove({ sessionID, key: REMINDER_KEY })
        .catch(() => {});
    });

    // Track per-session tool activity so the wall-clock nudge can tell a
    // working-but-silent agent apart from a session stalled in a provider
    // queue (or abandoned). Always registered, even with strict mode off.
    const activeToolHook = await ctx.tool.hook('execute.before', (event) => {
      activeToolCounts.set(
        event.sessionID,
        (activeToolCounts.get(event.sessionID) ?? 0) + 1
      );
    });

    const activityHook = await ctx.tool.hook('execute.after', (event) => {
      activeToolCounts.set(
        event.sessionID,
        Math.max(0, (activeToolCounts.get(event.sessionID) ?? 0) - 1)
      );
      lastToolCallAt.set(event.sessionID, Date.now());
      // Delegation telemetry: record subagent launches (Dax's general vs
      // explore question, locally and continuously).
      if (verbose && /subagent|(^|_)task$/.test(event.tool)) {
        const input = (event.input ?? {}) as { agent?: string; subagent_type?: string; description?: string };
        logNudge({
          event: 'subagent',
          sessionID: event.sessionID,
          tool: event.tool,
          agent: input.agent ?? input.subagent_type ?? null,
          description: input.description ?? null,
        });
      }
    });

    // Custom nudges: evaluate event/step rules after each tool completes,
    // when in-flight suppression has already been decremented.
    let customNudgeToolHook: Awaited<ReturnType<typeof ctx.tool.hook>> | undefined;
    let customNudgeTimer: ReturnType<typeof setInterval> | undefined;
    if (customNudgesOn) {
    customNudgeToolHook = await ctx.tool.hook('execute.after', (event) => {
      knownSessions.add(event.sessionID);
      evaluateCustomNudges(event.sessionID);
      // A child session's rule may watch the parent tree (`sessions: self`);
      // reevaluate the root so a parent rule can react to child activity.
      const root = rootSessionFor(event.sessionID, readSessionMap());
      if (root && root !== event.sessionID) {
        knownSessions.add(root);
        evaluateCustomNudges(root);
      }
    });

    // Clock-triggered rules need their own tick; 5s keeps 5s intervals usable
    // without a per-rule timer.
    customNudgeTimer = setInterval(() => {
      for (const sessionID of knownSessions) {
        evaluateCustomNudges(sessionID, { timer: true });
      }
    }, 5_000);
    }

    // Pre-flight relay hint: see a long-running command BEFORE it runs and
    // suggest wrapping it in the relay. Detection only — commands are never
    // rewritten. Opt out with { options: { relayHints: false } }.
    // One hint per repeating command shape, emitted on the second occurrence.
    // A single long command already gets the relay hint in the progress tool
    // response, so nagging after it has finished is pure noise.
    const relayPatternCounts = new Map<string, Map<string, number>>();
    const relayPatternHinted = new Map<string, Set<string>>();
    let relayHintHook: Awaited<ReturnType<typeof ctx.tool.hook>> | undefined;
    if (ctx.options?.relayHints !== false) {
      relayHintHook = await ctx.tool.hook('execute.before', (event) => {
        try {
          if (!/^(bash|shell)$/.test(event.tool)) return;
          const input = event.input as { command?: string } | undefined;
          const command = typeof input?.command === 'string' ? input.command : '';
          const match = relayHintFor(command);
          if (!match) return;
          const pattern = relayCommandPattern(command);
          if (!pattern) return;
          const counts =
            relayPatternCounts.get(event.sessionID) ?? new Map<string, number>();
          const count = (counts.get(pattern) ?? 0) + 1;
          counts.set(pattern, count);
          relayPatternCounts.set(event.sessionID, counts);
          const hinted =
            relayPatternHinted.get(event.sessionID) ?? new Set<string>();
          if (count < 2 || hinted.has(pattern)) return;
          hinted.add(pattern);
          relayPatternHinted.set(event.sessionID, hinted);
          putReminder(
            event.sessionID,
            'info',
            'relay',
            relayPatternHintMessage(pattern, count, match)
          );
          if (verbose) {
            logNudge({
              event: 'relay-hint',
              sessionID: event.sessionID,
              pattern,
              count,
              command: match.slice(0, 120),
            });
          }
        } catch (error) {
          console.error('[opencode-progress] relay hint failed', String(error));
        }
      });
    }

    let wallTimer: ReturnType<typeof setInterval> | undefined;
    if (wallClockMs > 0) {
      wallTimer = setInterval(() => {
        try {
          const entries = Object.values(readProgressState().entries ?? {});
          const sessions = new Set(
            entries.map((entry) => entry?.sessionId).filter((id): id is string => Boolean(id))
          );
          const now = Date.now();
          for (const sessionID of sessions) {
            const sessionEntries = entries.filter((entry) => entry?.sessionId === sessionID);
            observeTransitions(sessionID, sessionEntries);
            const hasActive = sessionEntries.some(
              (entry) =>
                (entry.status === 'running' || entry.status === 'waiting') &&
                !entry.dismissed &&
                !isHealthyWaiting(entry, now, staleAfterMs)
            );
            if (
              hasActive &&
              hasActiveChildren(sessionID, now, Math.max(wallClockMs, staleAfterMs))
            ) {
              // Children are working: give the parent a fresh grace window
              // instead of firing the moment they finish.
              wallTrackers.set(sessionID, { lastAt: now, streak: 0 });
              continue;
            }
            const lastProgressAt = Math.max(
              sessionEntries.reduce((max, entry) => Math.max(max, entry.updatedAt ?? 0), 0),
              promptAt.get(sessionID) ?? 0
            );
            if ((activeToolCounts.get(sessionID) ?? 0) > 0) continue;
            // Progress changed since the last tick ⇒ reset the reminder streak.
            const previousSeen = lastSeenProgress.get(sessionID) ?? 0;
            if (lastProgressAt > previousSeen) lastSeenProgress.set(sessionID, lastProgressAt);
            const tracker = wallTrackers.get(sessionID) ?? { lastAt: 0, streak: 0 };
            if (lastProgressAt > previousSeen) tracker.streak = 0;
            const decision = wallClockNudge(
              tracker,
              {
                hasActive,
                lastProgressAt,
                lastToolCallAt: lastToolCallAt.get(sessionID),
                now,
                target: pickTarget(sessionEntries, now),
              },
              { thresholdMs: wallClockMs }
            );
            wallTrackers.set(sessionID, { lastAt: decision.lastAt, streak: decision.streak });

            if (decision.action === 'remind' && decision.message) {
              console.log(`[opencode-progress] v${pluginVersion} wall-clock nudge for ${sessionID}`);
              if (verbose) {
                logNudge({ event: 'wall-clock', sessionID, ageMinutes: Math.round((now - lastProgressAt) / 60000), activeEntries: sessionEntries.filter((e) => e.status === 'running' || e.status === 'waiting').length });
              }
              putReminder(sessionID, 'warn', 'wall', decision.message);
            } else if (!hasActive || now - lastProgressAt < wallClockMs) {
              // Clear only the wall-sourced reminder; never wipe a stricter
              // standing reminder from another source.
              clearReminder(sessionID, 'wall');
            }
          }
        } catch (error) {
          console.error('[opencode-progress] wall-clock nudge failed', String(error));
        }
      }, 30_000);
      console.log(`[opencode-progress] v${pluginVersion} wall-clock nudge: ${Math.round(wallClockMs / 60000)}m`);
    }

    console.log(`[opencode-progress] server part v${pluginVersion} loaded`);

    return () => {
      clearInterval(timer);
      if (wallTimer) clearInterval(wallTimer);
      void rulesRegistration?.dispose();
      void toolHook?.dispose();
      void idleHook?.dispose();
      void promptReminderHook?.dispose();
      void activityHook?.dispose();
      void activeToolHook?.dispose();
      void customNudgeToolHook?.dispose();
      if (customNudgeTimer) clearInterval(customNudgeTimer);
      void promptResetHook?.dispose();
      void relayHintHook?.dispose();
      void sayNudgeBeforeHook?.dispose();
      void sayNudgeAfterHook?.dispose();
      void sayRegistration?.dispose();
      void sayPromptHook?.dispose();
      void sayIdleHook?.dispose();
    };
  },
});
