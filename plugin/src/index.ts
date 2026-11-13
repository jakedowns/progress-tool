/**
 * OpenCode Progress Plugin — server part.
 *
 * Watches the shared progress state file written by the progress MCP server /
 * relay and exposes it to the TUI and GUI parts through RPC.
 */

import { Plugin } from "@opencode/plugin";
import { ProgressRpc } from "./rpc.js";
import { readProgressState } from "./state.js";

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

    const timer = setInterval(() => {
      const next = JSON.stringify(readProgressState().entries ?? {});
      if (next === signature) return;
      signature = next;
      void registration.events.emit("updated", { updatedAt: Date.now() }).catch(() => {});
    }, 1000);

    console.log("[opencode-progress] server part loaded");

    return () => clearInterval(timer);
  },
});
