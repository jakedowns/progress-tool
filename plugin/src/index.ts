/**
 * OpenCode Progress Plugin — server part.
 *
 * Watches the shared progress state file written by the progress MCP server /
 * relay and exposes it to the TUI and GUI parts through RPC.
 */

import { Plugin } from "@opencode/plugin";
import { ProgressRpc } from "./rpc.js";
import { readProgressState } from "./state.js";
import { normalizeRefreshMs } from "./tree.js";
import { PROGRESS_RULES, instructionsEnabled } from "./instructions.js";

export default Plugin.define({
  id: "opencode-progress",
  async setup(ctx) {
    let signature = JSON.stringify(readProgressState().entries ?? {});

    const registration = await ctx.rpc.register(ProgressRpc, {
      list: async () => {
        const state = readProgressState();
        return { entries: state.entries ?? {}, updatedAt: Date.now() };
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

    console.log("[opencode-progress] server part loaded");

    return () => {
      clearInterval(timer);
      void rulesRegistration?.dispose();
    };
  },
});
