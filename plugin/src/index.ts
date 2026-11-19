/**
 * OpenCode Progress Plugin — server part.
 *
 * Watches the shared progress state file written by the progress MCP server /
 * relay and exposes it to the TUI and GUI parts through RPC.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Plugin, Skill } from "@opencode/plugin";
import { ProgressRpc } from "./rpc.js";
import { readProgressState, writeDismissal } from "./state.js";
import { normalizeRefreshMs } from "./tree.js";
import { PROGRESS_RULES, instructionsEnabled } from "./instructions.js";
import {
  observeToolCall,
  normalizeStrictMode,
  normalizeStaleAfterMs,
  normalizeWallClockMs,
  silentRunNudge,
  staleProgressNudge,
  idleReminder,
  wallClockNudge,
  relayHintFor,
  relayHintMessage,
  type MonitorState,
  type IdleTracker,
  type WallClockState,
} from "./monitor.js";
import { logNudge, nudgeLoggingEnabled, diffStatuses, type StatusSnapshot } from "./telemetry.js";

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

/** Skills shipped in the package and registered at setup (see plugin/skills/). */
const PLUGIN_DIR = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const PACKAGED_SKILLS = [
  {
    id: "progress-tool",
    name: "Progress Tool Usage",
    description:
      "Use the progress-tool MCP correctly — report long-horizon work (research, planning, exploration, refactors, docs) with the fire-and-forget progress tool, structure multi-step plans as a parentId tree, keep entries current between tool calls, and wrap long-running commands with the out-of-band progress-relay at zero token cost",
  },
  {
    id: "osc-demo",
    name: "OSC 9;4 Demo",
    description:
      "Demo OSC 9;4 terminal progress support in progress-tool — run a fake build that streams native OSC 9;4 progress sequences through the out-of-band relay (progress-relay), zero agent tokens",
  },
  {
    id: "tree-demo",
    name: "Task Tree Demo",
    description:
      "Demo nested task trees (parentId roll-up) in progress-tool — run a fake release pipeline with parent, child, and grandchild tasks streaming through the out-of-band relay at zero agent tokens, with an optional failure mode that rolls an error up the tree",
  },
  {
    id: "delegation",
    name: "Delegation (Subagents)",
    description:
      "Use subagents well — fan out independent research and verification in parallel, pick explore vs general, inherit the session's model, and avoid parallel-edit conflicts",
  },
];

function loadPackagedSkillBody(id: string): string {
  // Strip frontmatter: the skill tool adds the Markdown body, and the
  // directory copies keep frontmatter for repo-local discovery.
  const raw = readFileSync(path.join(PLUGIN_DIR, "skills", id, "SKILL.md"), "utf8");
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trimStart();
}

export default Plugin.define({
  id: "opencode-progress",
  async setup(ctx) {
    let signature = JSON.stringify(readProgressState().entries ?? {});

    const registration = await ctx.rpc.register(ProgressRpc, {
      list: async () => {
        const state = readProgressState();
        return { entries: state.entries ?? {}, updatedAt: Date.now() };
      },
      dismiss: async ({ key, status }) => {
        const ok = writeDismissal(key, status);
        console.log(`[opencode-progress] v${pluginVersion} dismiss rpc key=${key} status=${status} ok=${ok}`);
        return { ok };
      },
    });

    const refreshMs = normalizeRefreshMs(ctx.options);

    const timer = setInterval(() => {
      const next = JSON.stringify(readProgressState().entries ?? {});
      if (next === signature) return;
      signature = next;
      void registration.events.emit("updated", { updatedAt: Date.now() }).catch(() => {});
    }, refreshMs);

    // Inject the progress & relay rules into the agent loop's system
    // instructions so agents know about the out-of-band relay BEFORE their
    // first long-running command, not only from the `progress` tool response.
    // Opt out per project with `{ "options": { "injectInstructions": false } }`.
    let rulesRegistration: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;
    if (instructionsEnabled(ctx.options)) {
      rulesRegistration = await ctx.session.hook("context", (event) => {
        event.system.push({ type: "text", text: PROGRESS_RULES });
      });
      console.log("[opencode-progress] progress rules injected into system instructions");
    }

    // Ship the usage + demo skills with the package so installing the plugin
    // installs the skills. Opt out per project with
    // `{ "options": { "registerSkills": false } }`.
    if (ctx.options?.registerSkills !== false) {
      await ctx.skill.transform((editor) => {
        for (const skill of PACKAGED_SKILLS) {
          editor.add({
            id: Skill.ID.make(skill.id),
            name: Skill.Name.make(skill.name),
            description: skill.description,
            path: Skill.Info.fields.path.make(path.join(PLUGIN_DIR, "skills", skill.id, "SKILL.md")),
            content: loadPackagedSkillBody(skill.id),
            autoinvoke: true,
          });
        }
      });
      console.log(`[opencode-progress] v${pluginVersion} registered ${PACKAGED_SKILLS.length} packaged skills`);
    }

    // Strict mode: watch tool calls and nudge when the agent works silently
    // (no task entry) or leaves pending tasks' progress unchanged.
    const strictMode = normalizeStrictMode(ctx.options);
    const staleAfterMs = normalizeStaleAfterMs(ctx.options);
    const strictThreshold =
      typeof ctx.options?.strictThreshold === 'number' && ctx.options.strictThreshold >= 2
        ? ctx.options.strictThreshold
        : 3;
    const monitors = new Map<string, MonitorState>();
    const verbose = nudgeLoggingEnabled(ctx.options);

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
    const NUDGE_KEY = 'progress-nudge';
    let promptReminderHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;

    let toolHook: Awaited<ReturnType<typeof ctx.tool.hook>> | undefined;
    if (strictMode !== 'off') {
      toolHook = await ctx.tool.hook('execute.after', (event) => {
        try {
          const isProgressCall = /(^|_)progress$/.test(event.tool);
          const entries = Object.values(readProgressState().entries ?? {}).filter(
            (entry) => entry && entry.sessionId === event.sessionID
          );
          const hasActive = entries.some(
            (entry) => entry.status === 'running' || entry.status === 'waiting'
          );
          const lastProgressAt = entries.reduce(
            (max, entry) => Math.max(max, entry.updatedAt ?? 0),
            0
          );

          const previousSeen = lastSeenProgress.get(event.sessionID) ?? 0;
          const progressAdvanced = lastProgressAt > previousSeen;
          if (lastProgressAt > previousSeen) lastSeenProgress.set(event.sessionID, lastProgressAt);
          observeTransitions(event.sessionID, entries);

          const monitor = monitors.get(event.sessionID) ?? {
            count: 0,
            callsSinceProgress: 0,
            nudged: false,
            forced: false,
            lastStaleNudgeAt: 0,
          };
          const step = observeToolCall(
            monitor,
            {
              isProgressCall,
              hasActive,
              lastProgressAt: lastProgressAt || undefined,
              progressAdvanced,
              now: Date.now(),
            },
            { strictMode, staleAfterMs, threshold: strictThreshold }
          );

          monitor.count = step.count;
          monitor.callsSinceProgress = step.callsSinceProgress;
          monitor.lastStaleNudgeAt = step.lastStaleNudgeAt;
          if (step.action === 'nudge' || step.action === 'force' || step.action === 'stale-nudge') {
            monitor.nudged = true;
          }
          if (step.action === 'force') monitor.forced = true;
          if (step.action === 'clear') monitor.nudged = false;
          monitors.set(event.sessionID, monitor);

          if (verbose && step.action !== 'none' && step.action !== 'clear') {
            logNudge({
              event: 'strict',
              action: step.action,
              sessionID: event.sessionID,
              count: step.count,
              callsSinceProgress: step.callsSinceProgress,
            });
          }
          if (verbose && event.status === 'completed') {
            const resultText = JSON.stringify(event.result ?? '');
            if (resultText.includes('INVALID USAGE')) {
              logNudge({ event: 'child-list-error', sessionID: event.sessionID, tool: event.tool });
            }
          }

          const text =
            step.action === 'stale-nudge'
              ? staleProgressNudge(step.callsSinceProgress)
              : silentRunNudge(step.count);

          if (step.action === 'nudge' || step.action === 'force' || step.action === 'stale-nudge') {
            void ctx.session.instructions.entry
              .put({ sessionID: event.sessionID, key: NUDGE_KEY, value: text })
              .catch(() => {});
          }
          if (step.action === 'force') {
            void ctx.session
              .synthetic({ sessionID: event.sessionID, text })
              .catch(() => {});
          }
          if (step.action === 'clear') {
            void ctx.session.instructions.entry
              .remove({ sessionID: event.sessionID, key: NUDGE_KEY })
              .catch(() => {});
          }
        } catch (error) {
          console.error('[opencode-progress] strict-mode monitor failed', String(error));
        }
      });
      console.log(`[opencode-progress] v${pluginVersion} strict mode: ${strictMode} (threshold ${strictThreshold})`);
    if (verbose) {
      logNudge({ event: "config", strictMode, strictThreshold, wallClockMs: normalizeWallClockMs(ctx.options), idleReminder: ctx.options?.idleReminder !== false, unhinged: ctx.options?.unhinged === true });
    }
    }

    // Idle reminder: at turn end (session about to go idle) with open,
    // non-dismissed entries, admit ONE synthetic message — it runs in the
    // same execution instead of the session going idle, so the model gets a
    // turn-end reminder ("you have a tree of todos pending"). Debounced by
    // entry signature + cooldown + per-run cap (monitor.ts).
    const idleTrackers = new Map<string, IdleTracker>();
    let idleHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;
    if (ctx.options?.idleReminder !== false) {
      idleHook = await ctx.session.hook('experimental.idle', async (event) => {
        try {
          const entries = Object.values(readProgressState().entries ?? {}).filter(
            (entry) => entry && entry.sessionId === event.sessionID
          );
          const tracker = idleTrackers.get(event.sessionID) ?? { signature: '', lastAt: 0, count: 0 };
          const decision = idleReminder(tracker, entries, { now: Date.now() });
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
          await ctx.session.synthetic({ sessionID: event.sessionID, text: decision.message });
        } catch (error) {
          console.error('[opencode-progress] idle reminder failed', String(error));
        }
      });
    }

    // "Unhinged" mode (opt-in): append a progress reminder to every user
    // message so the agent re-checks its task list whenever the workload
    // changes. Off by default — it edits user input text.
    if (ctx.options?.unhinged === true) {
      const promptHook = await ctx.session.hook('prompt', (event) => {
        event.prompt.text = `${event.prompt.text}\n\n[did the user's message just change your workload? update your task list!]`;
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
    const wallClockMs = normalizeWallClockMs(ctx.options);
    const wallTrackers = new Map<string, WallClockState>();
    const lastToolCallAt = new Map<string, number>();
    const WALL_KEY = 'progress-wall-clock';

    // Track per-session tool activity so the wall-clock nudge can tell a
    // working-but-silent agent apart from a session stalled in a provider
    // queue (or abandoned). Always registered, even with strict mode off.
    const activityHook = await ctx.tool.hook('execute.after', (event) => {
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

    // Pre-flight relay hint: see a long-running command BEFORE it runs and
    // suggest wrapping it in the relay. Detection only — commands are never
    // rewritten. Opt out with { options: { relayHints: false } }.
    const relayHintCooldown = new Map<string, number>();
    let relayHintHook: Awaited<ReturnType<typeof ctx.tool.hook>> | undefined;
    if (ctx.options?.relayHints !== false) {
      relayHintHook = await ctx.tool.hook('execute.before', (event) => {
        try {
          if (!/^(bash|shell)$/.test(event.tool)) return;
          const input = event.input as { command?: string } | undefined;
          const command = typeof input?.command === 'string' ? input.command : '';
          const match = relayHintFor(command);
          if (!match) return;
          const now = Date.now();
          if (now - (relayHintCooldown.get(event.sessionID) ?? 0) < 90_000) return;
          relayHintCooldown.set(event.sessionID, now);
          void ctx.session.instructions.entry
            .put({ sessionID: event.sessionID, key: 'progress-relay-hint', value: relayHintMessage(match) })
            .catch(() => {});
          if (verbose) {
            logNudge({ event: 'relay-hint', sessionID: event.sessionID, command: match.slice(0, 120) });
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
              (entry) => entry.status === 'running' || entry.status === 'waiting'
            );
            const lastProgressAt = sessionEntries.reduce(
              (max, entry) => Math.max(max, entry.updatedAt ?? 0),
              0
            );
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
              },
              { thresholdMs: wallClockMs }
            );
            wallTrackers.set(sessionID, { lastAt: decision.lastAt, streak: decision.streak });

            if (decision.action === 'remind' && decision.message) {
              console.log(`[opencode-progress] v${pluginVersion} wall-clock nudge for ${sessionID}`);
              if (verbose) {
                logNudge({ event: 'wall-clock', sessionID, ageMinutes: Math.round((now - lastProgressAt) / 60000), activeEntries: sessionEntries.filter((e) => e.status === 'running' || e.status === 'waiting').length });
              }
              void ctx.session.instructions.entry
                .put({ sessionID, key: WALL_KEY, value: decision.message })
                .catch(() => {});
            } else if (hasActive && now - lastProgressAt < wallClockMs) {
              void ctx.session.instructions.entry
                .remove({ sessionID, key: WALL_KEY })
                .catch(() => {});
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
      void relayHintHook?.dispose();
    };
  },
});
