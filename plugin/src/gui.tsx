/**
 * OpenCode Progress Plugin — desktop / web GUI part.
 *
 * Runs in every app window (Electron and browser) and contributes a composer
 * pill next to the native status row. The pill's menu lists the dependency
 * tree, including nested children.
 */

import { ComposerPill, Plugin } from "@opencode/plugin/gui";
import { createSignal } from "solid-js";
import { ProgressRpc } from "./rpc.js";
import { buildTree, countActive, flattenTree, progressLabel } from "./tree.js";
import type { ProgressEntry, TreeNode } from "./types.js";

type GuiState = {
  entries: Record<string, ProgressEntry>;
  loaded: boolean;
};

function toneFor(status: TreeNode["status"]): "success" | "warning" | "danger" | undefined {
  if (status === "error") return "danger";
  if (status === "done") return "success";
  if (status === "waiting") return "warning";
  return undefined;
}

function rowFor(node: TreeNode) {
  const pct = progressLabel(node.progress);
  return {
    id: node.key,
    label: pct ? `${node.title} · ${pct}` : node.title,
    detail: node.detail || undefined,
    tone: toneFor(node.status),
  };
}

export default Plugin.define({
  setup(ctx) {
    const [state, setState] = createSignal<GuiState>({ entries: {}, loaded: false });
    let alive = true;

    const refresh = async () => {
      try {
        const result = await ctx.client.rpc(ProgressRpc).list();
        if (!alive) return;
        setState({
          entries: (result?.entries ?? {}) as Record<string, ProgressEntry>,
          loaded: true,
        });
      } catch {
        // The server may be restarting; the next tick retries.
      }
    };

    void refresh();
    const timer = setInterval(() => void refresh(), 1500);

    ctx.add(ComposerPill, () => {
      const roots = buildTree(state().entries);
      if (roots.length === 0) return undefined;

      const active = countActive(roots);
      const top = roots[0];
      const pct = progressLabel(top.progress);

      return {
        id: "progress",
        label: active > 0
          ? `${top.title}${pct ? ` ${pct}` : ""}`
          : `${roots.length} tracked`,
        title: active > 0 ? `${active} active task${active === 1 ? "" : "s"}` : "Agent progress",
        rows: flattenTree(roots).slice(0, 6).map(rowFor),
      };
    });

    return () => {
      alive = false;
      clearInterval(timer);
    };
  },
});
