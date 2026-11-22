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
  readProgressState,
  recordChildSession,
  writeDismissal,
} from "./state.js";
import { normalizeRefreshMs } from "./tree.js";
import {
  PROGRESS_RULES,
  instructionsEnabled,
  sessionAttributionRules,
} from "./instructions.js";
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
import { resolveMcpLaunch } from "./mcp.js";
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
          await ctx.mcp.transform((editor) => {
            if (editor.get("progress-server")) return;
            editor.set("progress-server", {
              type: "local",
              command: launch.command,
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

    // Whether the `progress` tool is actually present in the outgoing request.
    // A config entry is not proof the MCP server connected, and MCP connects
    // asynchronously, so inspect the model's tool set on every context hook.
    // This keeps guidance honest: no "call the progress tool" nudges when the
    // tool is unavailable (issue #1, related UX).
    const progressTool = { available: false, warned: false };
    const hasProgressTool = (tools: Record<string, unknown> | undefined): boolean =>
      Boolean(tools) && Object.keys(tools ?? {}).some((name) => /progress/i.test(name));

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
    //
    // Rules are only injected while the `progress` tool is actually in the
    // model's tool set: if the MCP server failed to start, telling the agent to
    // call a tool that doesn't exist just produces phantom tool calls.
    const strictMode = normalizeStrictMode(ctx.options);
    const staleAfterMs = normalizeStaleAfterMs(ctx.options);
    const strictThreshold =
      typeof ctx.options?.strictThreshold === 'number' && ctx.options.strictThreshold >= 2
        ? ctx.options.strictThreshold
        : 3;
    const verbose = nudgeLoggingEnabled(ctx.options);

    let rulesRegistration: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;
    if (instructionsEnabled(ctx.options) || strictMode !== 'off') {
      const injectRules = instructionsEnabled(ctx.options);
      rulesRegistration = await ctx.session.hook("context", async (event) => {
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
              `[opencode-progress] v${pluginVersion} progress tool not available — skipping rule injection and strict nudges until progress-server connects`
            );
          }
          return;
        }

        if (progressTool.warned) {
          progressTool.warned = false;
          console.log(`[opencode-progress] v${pluginVersion} progress tool available — guidance enabled`);
        }
        if (!injectRules) return;
        event.system.push({ type: "text", text: PROGRESS_RULES });
        const sessionID = (event as unknown as { sessionID?: string }).sessionID;
        if (sessionID) {
          event.system.push({ type: "text", text: sessionAttributionRules(sessionID) });
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
    const NUDGE_KEY = 'progress-nudge';
    let promptReminderHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;

    let toolHook: Awaited<ReturnType<typeof ctx.tool.hook>> | undefined;
    if (strictMode !== 'off') {
      toolHook = await ctx.tool.hook('execute.after', (event) => {
        try {
          // Guidance is only meaningful when the progress tool exists; the
          // context hook flips this on once the MCP server has connected.
          if (!progressTool.available) return;
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
      console.log(`[opencode-progress] v${pluginVersion} strict mode: ${strictMode} (threshold ${strictThreshold}, gated on progress tool availability)`);
    if (verbose) {
      logNudge({ event: "config", strictMode, strictThreshold, wallClockMs: normalizeWallClockMs(ctx.options), idleReminder: ctx.options?.idleReminder !== false, unhinged: ctx.options?.unhinged === true });
    }
    }

    // Subagent attribution, part 1: `session.created` carries parentID the
    // moment a child session exists, so map (and adopt) before the child's
    // first progress call. Consumed in the background; the stream ends when
    // the plugin unloads.
    if (ctx.event?.subscribe) void (async () => {
      try {
        for await (const event of ctx.event.subscribe({ types: ['session.created'] })) {
          if (event.type !== 'session.created') continue;
          const child = event.data.sessionID;
          const parent = event.data.parentID;
          const agent = event.data.agent;
          if (!child || !parent) continue;
          if (recordChildSession(child, parent, agent)) {
            adoptChildEntries(child, parent, agent);
          }
        }
      } catch (error) {
        console.error('[opencode-progress] session.created subscription failed', String(error));
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
    let idleHook: Awaited<ReturnType<typeof ctx.session.hook>> | undefined;
    if (idleReminderEnabled) {
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
