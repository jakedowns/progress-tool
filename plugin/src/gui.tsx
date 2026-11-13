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
import {
  buildTree,
  barParts,
  countActive,
  flattenTreeWithDepth,
  normalizeBarOptions,
  normalizeVisibilityOptions,
  progressLabel,
  scopeEntries,
  visibleEntries,
  type BarOptions,
} from "./tree.js";
import type { ProgressEntry, TreeNode } from "./types.js";

type GuiState = {
  entries: Record<string, ProgressEntry>;
  loaded: boolean;
  error?: string;
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms)),
  ]);
}

function toneFor(status: TreeNode["status"]): "success" | "warning" | "danger" | undefined {
  if (status === "error") return "danger";
  if (status === "done") return "success";
  if (status === "waiting") return "warning";
  return undefined;
}

function rowFor(node: TreeNode, depth: number, options: BarOptions) {
  const parts = barParts(node.progress, options);
  const pct = progressLabel(node.progress);
  const indent = depth > 0 ? "\u00A0\u00A0".repeat(depth) + "└─ " : "";
  const suffix =
    parts.style === "emoji"
      ? `: ${parts.bar}${parts.fraction}`
      : pct
        ? ` · ${pct}`
        : "";
  return {
    id: node.key,
    label: `${indent}${node.title}${suffix}`,
    detail: node.detail || undefined,
    tone: toneFor(node.status),
  };
}

export default Plugin.define({
  setup(ctx) {
    const [state, setState] = createSignal<GuiState>({ entries: {}, loaded: false });
    const [dismissedAt, setDismissedAt] = createSignal(0);
    const [dismissedRoots, setDismissedRoots] = createSignal<Record<string, number>>({});
    const options = normalizeBarOptions(ctx.options);
    const visibility = normalizeVisibilityOptions(ctx.options);
    let alive = true;

    const refresh = async () => {
      try {
        const session = ctx.sessions.current();
        if (!session) {
          setState((prev) => ({ ...prev, loaded: true }));
          return;
        }
        const result = await withTimeout(session.server.client.rpc(ProgressRpc).list({}), 4000);
        if (!alive) return;
        setState({
          entries: (result?.entries ?? {}) as Record<string, ProgressEntry>,
          loaded: true,
        });
      } catch (error) {
        if (!alive) return;
        setState((prev) => ({ ...prev, loaded: true, error: String(error) }));
        console.error("[opencode-progress] rpc list failed", String(error));
      }
    };

    console.log("[opencode-progress] gui setup", ctx.app.version, ctx.app.platform);
    if (ctx.options?.notifyOnLoad === true) {
      ctx.toast.show({
        title: "Progress plugin loaded",
        description: `${ctx.app.platform} ${ctx.app.version}`,
        variant: "success",
        duration: 2500,
      });
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 1500);

    ctx.add(ComposerPill, () => ({
      id: "progress",
      show: (input) => {
        const current = state();
        const scoped = scopeEntries(current.entries, input.session.id, visibility);
        const empty = Object.keys(scoped).length === 0;

        if (current.error && empty) {
          return {
            label: "progress: error",
            title: "Progress plugin error",
            rows: [
              {
                id: "error",
                label: current.error.slice(0, 160),
                tone: "danger" as const,
              },
            ],
          };
        }

        if (!current.loaded && empty) {
          return { label: "progress: loading", title: "Progress plugin" };
        }

        const maxUpdatedAt = Object.values(scoped).reduce(
          (max, entry) => Math.max(max, entry?.updatedAt ?? 0),
          0
        );
        if (!empty && dismissedAt() >= maxUpdatedAt) return undefined;

        const roots = buildTree(visibleEntries(scoped, Date.now(), visibility));
        const dismissed = dismissedRoots();
        const visibleRoots = roots.filter(
          (root) => (dismissed[root.key] ?? 0) < (root.updatedAt ?? 0)
        );
        if (visibleRoots.length === 0) return undefined;

        const active = countActive(visibleRoots);
        const top = visibleRoots[0];
        const pct = progressLabel(top.progress);
        const parts = barParts(top.progress, options);
        const label =
          parts.style === "emoji"
            ? `${top.title}: ${parts.bar}${parts.fraction}`
            : active > 0
              ? `${top.title}${pct ? ` ${pct}` : ""}`
              : `${visibleRoots.length} tracked`;

        return {
          label,
          title: active > 0 ? `${active} active task${active === 1 ? "" : "s"}` : "Agent progress",
          rows: [
            ...flattenTreeWithDepth(visibleRoots)
              .slice(0, 7)
              .map(({ node, depth }) => {
                const row = rowFor(node, depth, options);
                if (depth !== 0) return row;
                return {
                  ...row,
                  icon: "circle-x" as const,
                  detail: row.detail ?? "dismiss",
                  run: () =>
                    setDismissedRoots((prev) => ({
                      ...prev,
                      [node.key]: node.updatedAt ?? 0,
                    })),
                };
              }),
            {
              id: "dismiss",
              label: "✕ Dismiss all",
              run: () => setDismissedAt(maxUpdatedAt),
            },
          ],
        };
      },
    }));

    return () => {
      alive = false;
      clearInterval(timer);
    };
  },
});
