/**
 * OpenCode Progress Plugin — desktop / web GUI part.
 *
 * Runs in every app window (Electron and browser) and contributes a composer
 * pill next to the native status row. The pill's menu lists the dependency
 * tree, including nested children.
 */

import { ComposerPill, Plugin } from "@opencode/plugin/gui";
import { For, Index, Show, createSignal } from "solid-js";
import pkg from "../package.json";
import { ProgressRpc } from "./rpc.js";
import {
  buildTree,
  barParts,
  countActive,
  flattenTreeWithDepth,
  isDismissed,
  normalizeBarOptions,
  normalizeProgressText,
  normalizeRefreshMs,
  normalizeVisibilityOptions,
  oneLineText,
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

function dotColor(status: TreeNode["status"]): string {
  if (status === "error") return "#ef4444";
  if (status === "done") return "#10b981";
  if (status === "waiting") return "#f59e0b";
  return "#3b82f6";
}

/** "Nov 18, 2:03 PM" in the viewer's locale and timezone. */
function formatDateTime(ms: number | undefined): string {
  if (!ms) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString();
  }
}

/** Human-readable age: "just now", "42 seconds ago", "3 minutes ago", ... */
function formatRelative(ms: number | undefined): string {
  if (!ms) return "";
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 10_000) return "just now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"} ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** Render normalized text with real <br> elements, never innerHTML. */
function Multiline(props: { text: string }) {
  return (
    <Index each={normalizeProgressText(props.text).split("\n")}>
      {(line, index) => (
        <>
          {index > 0 ? <br /> : null}
          {line()}
        </>
      )}
    </Index>
  );
}

function MenuRow(props: {
  node: TreeNode;
  depth: number;
  options: BarOptions;
  onDismiss?: () => void;
}) {
  const pct = () => progressLabel(props.node.progress);
  const parts = () => barParts(props.node.progress, props.options);

  return (
    <div
      style={{
        display: "flex",
        "align-items": "flex-start",
        gap: "8px",
        "padding-left": `${props.depth * 14}px`,
        "padding-top": "5px",
        "padding-bottom": "5px",
      }}
    >
      <div
        style={{
          width: "8px",
          height: "8px",
          "border-radius": "50%",
          "margin-top": "6px",
          flex: "0 0 auto",
          background: dotColor(props.node.status),
        }}
      />
      <div style={{ flex: "1 1 auto", "min-width": "0" }}>
        <div
          style={{
            "font-weight": props.depth === 0 ? "650" : "500",
            "white-space": "normal",
            "overflow-wrap": "anywhere",
            "word-break": "break-word",
          }}
          title={props.node.title}
        >
          <Multiline text={props.node.title} />
        </div>
        <Show when={props.node.detail}>
          <div
            style={{
              "margin-top": "2px",
              "font-size": "12px",
              opacity: "0.72",
              "white-space": "normal",
              "overflow-wrap": "anywhere",
              "word-break": "break-word",
            }}
            title={props.node.detail ?? ""}
          >
            <Multiline text={props.node.detail ?? ""} />
          </div>
        </Show>
        <div
          style={{
            "margin-top": "4px",
            display: "flex",
            gap: "8px",
            "align-items": "center",
            "font-size": "11px",
            opacity: "0.58",
          }}
        >
          <span style={{ "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
            {parts().bar}
          </span>
          <Show when={pct()}>
            <span>{pct()}</span>
          </Show>
          <Show when={props.node.startedAt}>
            <span
              title={`Last updated ${formatRelative(props.node.updatedAt)} (${formatDateTime(props.node.updatedAt)})`}
              style={{ "white-space": "nowrap", cursor: "default" }}
            >
              started {formatDateTime(props.node.startedAt)}
            </span>
          </Show>
        </div>
      </div>
      <Show when={props.onDismiss}>
        <button
          type="button"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={() => props.onDismiss?.()}
          style={{
            flex: "0 0 auto",
            border: "1px solid rgba(127,127,127,0.35)",
            background: "transparent",
            color: "inherit",
            opacity: "0.65",
            "border-radius": "50%",
            width: "22px",
            height: "22px",
            cursor: "pointer",
            "line-height": "1",
          }}
        >
          ×
        </button>
      </Show>
    </div>
  );
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
    label: `${indent}${oneLineText(node.title)}${suffix}`,
    detail: node.detail ? oneLineText(node.detail) : undefined,
    tone: toneFor(node.status),
  };
}

export default Plugin.define({
  setup(ctx) {
    const [state, setState] = createSignal<GuiState>({ entries: {}, loaded: false });
    // Dismissal is per root task and scoped to that task itself; the revival
    // semantics (re-report always revives, non-terminal status changes revive,
    // terminal dismissals only revive on failure or re-report) live in
    // tree.ts's isDismissed, shared and unit-tested.
    //
    // The dismissed state is PERSISTED in the shared state doc as
    // entry.dismissed = { status, at } (view-plane metadata written through
    // the plugin server's locked atomic writer), so it survives window
    // reloads and is shared by every view. This signal holds only optimistic
    // writes between the click and the next observed state.
    const [pendingDismissed, setPendingDismissed] = createSignal<Record<string, { status: string; at: number }>>({});
    const options = normalizeBarOptions(ctx.options);
    const visibility = normalizeVisibilityOptions(ctx.options);
    const refreshMs = normalizeRefreshMs(ctx.options);
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
        // Drop optimistic dismissals once the persisted state reflects them.
        setPendingDismissed((prev) => {
          const next = { ...prev };
          for (const [key, value] of Object.entries(prev)) {
            const d = (result?.entries ?? {})[key]?.dismissed;
            if (d && typeof d === "object" && (d as { at: number }).at >= value.at - 500) {
              delete next[key];
            }
          }
          return next;
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
        description: `${ctx.app.platform} · opencode-progress v${pkg.version}`,
        variant: "success",
        duration: 2500,
      });
    }
    void refresh();
    const timer = setInterval(() => void refresh(), refreshMs);

    /** Persisted dismissals, read straight from the state doc entries. */
    const dismissedFromEntries = () => {
      const map: Record<string, { status: string; at: number }> = {};
      for (const [key, entry] of Object.entries(state().entries)) {
        const d = entry.dismissed;
        if (d && typeof d === "object" && typeof d.at === "number") {
          map[key] = { status: String(d.status ?? ""), at: d.at };
        }
      }
      return map;
    };

    /** Persisted + optimistic: pending wins while newer than persisted. */
    const dismissedMap = () => {
      const merged = dismissedFromEntries();
      for (const [key, pending] of Object.entries(pendingDismissed())) {
        const persisted = merged[key];
        if (!persisted || pending.at > persisted.at) merged[key] = pending;
      }
      return merged;
    };

    type DismissSession = {
      server: {
        client: {
          rpc: (contract: unknown) => {
            dismiss(input: { key: string; status: string }): Promise<{ ok: boolean }>;
          };
        };
      };
    };

    /** Persist the dismissal via the plugin server, optimistically in-memory. */
    const dismissKey = (
      session: DismissSession,
      key: string,
      status: string
    ) => {
      setPendingDismissed((prev) => ({ ...prev, [key]: { status, at: Date.now() } }));
      void session.server.client
        .rpc(ProgressRpc)
        .dismiss({ key, status })
        .catch((error: unknown) =>
          console.error("[opencode-progress] dismiss rpc failed", String(error))
        );
    };

    const ProgressMenu = (props: { session: DismissSession; sessionID: string }) => {
      const scoped = () => scopeEntries(state().entries, props.sessionID, visibility);
      const visibleRoots = () => {
        const roots = buildTree(visibleEntries(scoped(), Date.now(), visibility));
        return roots.filter((root) => !isDismissed(root, dismissedMap()));
      };
      const rows = () => flattenTreeWithDepth(visibleRoots());

      return (
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "2px",
            "max-height": "min(60vh, 520px)",
            "overflow-y": "auto",
            "overflow-x": "hidden",
            "min-width": "320px",
            "max-width": "520px",
            "padding-right": "4px",
          }}
        >
          <Show
            when={rows().length > 0}
            fallback={
              <div style={{ opacity: "0.6", "font-size": "13px", padding: "8px" }}>
                No active progress
              </div>
            }
          >
            <For each={rows()}>
              {({ node, depth }) => (
                <MenuRow
                  node={node}
                  depth={depth}
                  options={options}
                  onDismiss={
                    depth === 0
                      ? () => dismissKey(props.session, node.key, node.status ?? "")
                      : undefined
                  }
                />
              )}
            </For>
            <button
              type="button"
              onClick={() => {
                for (const root of visibleRoots()) {
                  dismissKey(props.session, root.key, root.status ?? "");
                }
              }}
              style={{
                "margin-top": "6px",
                border: "none",
                background: "transparent",
                color: "inherit",
                opacity: "0.65",
                cursor: "pointer",
                "text-align": "left",
                padding: "6px 8px",
                "font-size": "12px",
              }}
            >
              ✕ Dismiss all
            </button>
          </Show>
          <div
            style={{
              "margin-top": "4px",
              padding: "4px 8px 6px",
              "font-size": "10px",
              opacity: "0.45",
              "user-select": "none",
            }}
          >
            progress plugin desktop v{pkg.version}
          </div>
        </div>
      );
    };

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

        const roots = buildTree(visibleEntries(scoped, Date.now(), visibility));
        const visibleRoots = roots.filter((root) => !isDismissed(root, dismissedMap()));
        if (visibleRoots.length === 0) return undefined;

        const active = countActive(visibleRoots);
        const top = visibleRoots[0];
        const topPct = progressLabel(top.progress);
        const parts = barParts(top.progress, options);
        const topTitle = oneLineText(top.title);

        // Multi-root pill: "(N · agg%)" — root count plus the mean of root
        // progress values (roll-up mean, nulls ignored; omitted when no root
        // has a numeric progress). The latest root is shown first.
        const rootProgresses = visibleRoots
          .map((root) => root.progress)
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        const aggregatePct =
          visibleRoots.length > 1 && rootProgresses.length > 0
            ? progressLabel(rootProgresses.reduce((a, b) => a + b, 0) / rootProgresses.length)
            : null;
        const pillSuffix =
          visibleRoots.length > 1
            ? ` (${visibleRoots.length}${aggregatePct ? ` · ${aggregatePct}` : ""})`
            : "";

        const label =
          parts.style === "emoji"
            ? `${topTitle}: ${parts.bar}${parts.fraction}${pillSuffix}`
            : active > 0
              ? `${topTitle}${topPct ? ` ${topPct}` : ""}${pillSuffix}`
              : `${topTitle}${pillSuffix}`;

        return {
          label,
          title: `${active > 0 ? `${active} active task${active === 1 ? "" : "s"}` : "Agent progress"}`,
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
                  run: () => dismissKey(input.session, node.key, node.status ?? ""),
                };
              }),
            {
              id: "dismiss",
              label: "✕ Dismiss all",
              run: () => {
                for (const root of visibleRoots) {
                  dismissKey(input.session, root.key, root.status ?? "");
                }
              },
            },
          ],
        };
      },
      menu: (input) => <ProgressMenu sessionID={input.session.id} />,
    }));

    return () => {
      alive = false;
      clearInterval(timer);
    };
  },
});
