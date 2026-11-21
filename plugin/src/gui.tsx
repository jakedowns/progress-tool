/**
 * OpenCode Progress Plugin — desktop / web GUI part.
 *
 * Runs in every app window (Electron and browser) and contributes a composer
 * pill next to the native status row. The pill's menu lists the dependency
 * tree, including nested children.
 */

import { ComposerPill, Plugin } from "@opencode/plugin/gui";
import { For, Index, Show, createEffect, createSignal } from "solid-js";
import pkg from "../package.json";
import { feedbackIssueUrl } from "./feedback.js";
import { ProgressRpc } from "./rpc.js";
import {
  buildTree,
  barParts,
  countActive,
  flattenTreeWithDepth,
  visibleRows,
  countDescendants,
  collapsedRootMap,
  summarizeEntries,
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
  leaving?: boolean;
  leaveDelayMs?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggle?: () => void;
}) {
  const pct = () => progressLabel(props.node.progress);
  const parts = () => barParts(props.node.progress, props.options);

  return (
    <div
      onClick={(event: MouseEvent) => {
        if (!props.hasChildren || props.leaving) return;
        // Do not hijack text selection drags.
        const selected = window.getSelection?.()?.toString();
        if (selected) return;
        event.preventDefault();
        props.onToggle?.();
      }}
      style={{
        display: "flex",
        "align-items": "flex-start",
        gap: "8px",
        "padding-left": `${props.depth * 14}px`,
        "padding-top": "5px",
        "padding-bottom": "5px",
        cursor: props.hasChildren && !props.leaving ? "pointer" : "default",
        transform: props.leaving ? "translateX(120%)" : "translateX(0)",
        opacity: props.leaving ? "0" : "1",
        transition: "transform 0.35s ease-in, opacity 0.3s ease-in",
        "transition-delay": `${props.leaveDelayMs ?? 0}ms`,
      }}
    >
      <Show when={props.hasChildren}>
        <span
          aria-hidden="true"
          style={{
            flex: "0 0 auto",
            opacity: "0.6",
            "font-size": "11px",
            width: "14px",
            "margin-top": "4px",
            "user-select": "none",
            "line-height": "1",
            display: "inline-block",
            transform: props.collapsed ? "rotate(0deg)" : "rotate(90deg)",
            transition: "transform 0.35s ease-in-out",
          }}
        >
          {props.collapsed ? "▸" : "▾"}
        </span>
      </Show>
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
          title={`${props.node.status}: ${oneLineText(props.node.title)}`}
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
            title={props.node.detail ? `${props.node.status}: ${oneLineText(props.node.detail)}` : ""}
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
          <Show when={props.collapsed && props.node.children.length > 0}>
            <span>&amp; {countDescendants(props.node)} more...</span>
          </Show>
        </div>
        <Show when={props.node.startedAt}>
          <div
            title={`Last updated ${formatRelative(props.node.updatedAt)} (${formatDateTime(props.node.updatedAt)})`}
            style={{
              "margin-top": "2px",
              "font-size": "11px",
              opacity: "0.58",
              "white-space": "nowrap",
              cursor: "default",
            }}
          >
            started {formatDateTime(props.node.startedAt)}
          </div>
        </Show>
      </div>
      <Show when={props.onDismiss}>
        <button
          type="button"
          class="progress-pill-button"
          title="Dismiss"
          aria-label="Dismiss"
          onClick={(event: MouseEvent) => {
            event.stopPropagation();
            props.onDismiss?.();
          }}
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

    console.log(`[opencode-progress] gui setup v${pkg.version} (opencode ${ctx.app.version}, ${ctx.app.platform})`);
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
      const [expandedOverrides, setExpandedOverrides] = createSignal<Record<string, boolean>>({});
      const expandByDefault = ctx.options?.expandRootsByDefault === true;
      const collapsedMap = () =>
        collapsedRootMap(visibleRoots(), expandByDefault, expandedOverrides());
      const rows = () => visibleRows(visibleRoots(), collapsedMap());
      const doneRoots = () => visibleRoots().filter((root) => root.status === "done");

      // Slide-away dismissal: mark the root as leaving (still rendered) and
      // slide it out sideways; once it has cleared the right edge, collapse
      // its container vertically, then actually dismiss so the filter removes
      // it. Dismiss-all staggers the rows slightly.
      const SLIDE_MS = 380;
      const COLLAPSE_MS = 300;
      const [leaving, setLeaving] = createSignal<Record<string, number>>({});
      const [leavingCollapsed, setLeavingCollapsed] = createSignal<Record<string, boolean>>({});
      const dismissAnimated = (root: TreeNode, delayMs = 0) => {
        if (leaving()[root.key] !== undefined) return;
        setLeaving((prev) => ({ ...prev, [root.key]: delayMs }));
        setTimeout(() => {
          setLeavingCollapsed((prev) => ({ ...prev, [root.key]: true }));
          setTimeout(() => {
            dismissKey(props.session, root.key, root.status ?? "");
            setLeaving((prev) => {
              const next = { ...prev };
              delete next[root.key];
              return next;
            });
            setLeavingCollapsed((prev) => {
              const next = { ...prev };
              delete next[root.key];
              return next;
            });
          }, COLLAPSE_MS + 20);
        }, delayMs + SLIDE_MS);
      };

      // Our own scroll container: <For> rebuilds row DOM when the tree
      // changes (e.g. after a dismiss), which resets scrollTop. Track the
      // user's position and restore it after each re-render.
      let listEl: HTMLDivElement | undefined;
      let scrollTop = 0;
      createEffect(() => {
        rows();
        const target = scrollTop;
        queueMicrotask(() => {
          if (listEl && listEl.scrollTop !== target) listEl.scrollTop = target;
        });
      });

      // Scroll the list so a root sits at the top of the viewport before its
      // exit animation starts.
      const scrollToRoot = (key: string) => {
        if (!listEl) return;
        const el = listEl.querySelector<HTMLElement>(
          `[data-root-key="${key.replace(/"/g, '\\"')}"]`
        );
        if (!el) return;
        const top =
          el.getBoundingClientRect().top -
          listEl.getBoundingClientRect().top +
          listEl.scrollTop;
        const next = Math.max(0, top - 2);
        listEl.scrollTop = next;
        scrollTop = next;
      };

      // Dismiss a batch (done / all): first bring the first row that will
      // animate into view, then stagger the rows.
      const dismissMany = (roots: TreeNode[]) => {
        const pending = roots.filter((root) => leaving()[root.key] === undefined);
        if (pending.length === 0) return;
        scrollToRoot(pending[0].key);
        pending.forEach((root, index) =>
          dismissAnimated(root, Math.min(index, 10) * 45)
        );
      };

      const footerButtonStyle = {
        flex: "1 1 auto",
        border: "none",
        background: "transparent",
        color: "inherit",
        opacity: "0.65",
        cursor: "pointer",
        "text-align": "left",
        padding: "3px 4px",
        "font-size": "12px",
      };

      return (
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            "min-width": "320px",
            "max-width": "520px",
          }}
        >
          <style>{`
            .progress-pill-button { cursor: pointer !important; }
            .progress-pill-button:hover { background: rgba(127,127,127,0.18) !important; }
          `}</style>
          <div
            ref={(el) => (listEl = el)}
            onScroll={(event) => {
              scrollTop = event.currentTarget.scrollTop;
            }}
            style={{
              display: "flex",
              "flex-direction": "column",
              gap: "2px",
              "flex": "0 1 auto",
              "min-height": "0",
              "max-height": "min(60vh, 520px)",
              "overflow-y": "auto",
              "overflow-x": "hidden",
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
            <For each={visibleRoots()}>
              {(root) => {
                const isCollapsed = () => collapsedMap()[root.key] ?? false;
                return (
                  // Outer wrapper collapses vertically once the row has slid
                  // fully past the right edge.
                  <div
                    data-root-key={root.key}
                    style={{
                      display: "grid",
                      "grid-template-rows": leavingCollapsed()[root.key] ? "0fr" : "1fr",
                      transition: "grid-template-rows 0.3s ease-in",
                    }}
                  >
                    <div style={{ overflow: "hidden", "min-height": "0" }}>
                      <MenuRow
                        node={root}
                        depth={0}
                        options={options}
                        hasChildren={root.children.length > 0}
                        collapsed={isCollapsed()}
                        onToggle={() =>
                          setExpandedOverrides((prev) => ({
                            ...prev,
                            [root.key]: !(prev[root.key] ?? expandByDefault),
                          }))
                        }
                        onDismiss={() => dismissAnimated(root)}
                        leaving={leaving()[root.key] !== undefined}
                        leaveDelayMs={leaving()[root.key] ?? 0}
                      />
                      <div
                        style={{
                          display: "grid",
                          "grid-template-rows": isCollapsed() ? "0fr" : "1fr",
                          transition: "grid-template-rows 0.5s ease-in-out, transform 0.35s ease-in, opacity 0.3s ease-in",
                          transform:
                            leaving()[root.key] !== undefined
                              ? "translateX(120%)"
                              : "translateX(0)",
                          opacity: leaving()[root.key] !== undefined ? "0" : "1",
                          "transition-delay": `${leaving()[root.key] ?? 0}ms`,
                        }}
                      >
                        <div style={{ overflow: "hidden", "min-height": "0" }}>
                          <For each={flattenTreeWithDepth(root.children, 1)}>
                            {({ node, depth }) => (
                              <MenuRow node={node} depth={depth} options={options} />
                            )}
                          </For>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              }}
            </For>
          </Show>
          </div>
          <Show when={rows().length > 0}>
            <div
              style={{
                display: "flex",
                gap: "2px",
                "margin-top": "2px",
                "padding-top": "2px",
                "border-top": "1px solid rgba(127,127,127,0.2)",
                "flex": "0 0 auto",
              }}
            >
              <Show when={doneRoots().length > 0}>
                <button
                  type="button"
                  class="progress-pill-button"
                  onClick={() => dismissMany(doneRoots())}
                  style={footerButtonStyle}
                >
                  ✓ Dismiss done ({doneRoots().length})
                </button>
              </Show>
              <button
                type="button"
                class="progress-pill-button"
                onClick={() => dismissMany(visibleRoots())}
                style={footerButtonStyle}
              >
                ✕ Dismiss all ({visibleRoots().length})
              </button>
            </div>
          </Show>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "4px",
              "padding": "1px 4px 2px",
              "font-size": "10px",
              opacity: "0.45",
              "user-select": "none",
            }}
          >
            <span>progress plugin desktop v{pkg.version}</span>
            <button
              type="button"
              class="progress-pill-button"
              onClick={() => ctx.system.openExternal(feedbackIssueUrl(pkg.version))}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              [Feedback]
            </button>
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

        // Collapsed pill prefix: the aggregate % shows even with a single
        // root; the root count is included only when there is more than one
        // ("(2 · 60%)", "(40%)"). Prefix placement survives truncation.
        const rootProgresses = visibleRoots
          .map((root) => root.progress)
          .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
        const aggregatePct =
          rootProgresses.length > 0
            ? progressLabel(rootProgresses.reduce((a, b) => a + b, 0) / rootProgresses.length)
            : null;
        const pillPrefix = aggregatePct
          ? `(${visibleRoots.length > 1 ? `${visibleRoots.length} · ` : ""}${aggregatePct}) `
          : visibleRoots.length > 1
            ? `(${visibleRoots.length}) `
            : "";

        const label =
          parts.style === "emoji"
            ? `${pillPrefix}${topTitle}: ${parts.bar}${parts.fraction}`
            : active > 0
              ? `${pillPrefix}${topTitle}${topPct ? ` ${topPct}` : ""}`
              : `${pillPrefix}${topTitle}`;

        return {
          label,
          // Headline counts include descendants (the store, not just roots):
          // "4 active · 3 done · 2 dismissed".
          title: (() => {
            const summary = summarizeEntries(scoped);
            const parts: string[] = [];
            if (summary.active > 0) parts.push(`${summary.active} active`);
            if (summary.done > 0) parts.push(`${summary.done} done`);
            if (summary.dismissed > 0) parts.push(`${summary.dismissed} dismissed`);
            return parts.length > 0 ? parts.join(" · ") : "Agent progress";
          })(),
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
      menu: (input) => (
        <ProgressMenu session={input.session} sessionID={input.session.id} />
      ),
    }));

    return () => {
      alive = false;
      clearInterval(timer);
    };
  },
});
