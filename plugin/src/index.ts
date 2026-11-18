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

    console.log(`[opencode-progress] server part v${pluginVersion} loaded`);

    return () => {
      clearInterval(timer);
      void rulesRegistration?.dispose();
    };
  },
});
