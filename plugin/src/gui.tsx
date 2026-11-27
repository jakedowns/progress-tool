/**
 * OpenCode Progress Plugin — desktop / web GUI part.
 *
 * Runs in every app window (Electron and browser) and contributes a composer
 * pill next to the native status row. The pill's menu lists the dependency
 * tree, including nested children.
 */

import { ComposerPill, Command, MenuItem, Panel, Plugin, Style } from "@opencode/plugin/gui";
import type { MountedSession } from "@opencode/plugin/gui";
import { ErrorBoundary, For, Index, Show, batch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { displayVersion } from "./build-version.js";
import { feedbackIssueUrl, releasesUrl } from "./feedback.js";
import { ProgressRpc } from "./rpc.js";
import {
  GUI_PROGRESS_PANEL_ID,
  buildNoteToast,
  buildNotesPill,
  nextGuiLayout,
  noteAuthorLabel,
  normalizeGuiDetailLines,
  normalizeGuiLayout,
  normalizeGuiSidebarWidth,
  nudgeFeedRows,
  type GuiLayout,
} from "./gui-view.js";
import {
  guiSaySurfaces,
  normalizeSayOptions,
  sayToastDurationMs,
  sayToastNotes,
  visibleSayNotes,
} from "./say.js";
import { buildNotesLine } from "./tui-view.js";
import {
  buildTree,
  buildVisibleTree,
  barParts,
  countActive,
  flattenTreeWithDepth,
  visibleRows,
  compactTreeSuffix,
  countDescendants,
  collapsedRootMap,
  summarizeEntries,
  isDismissed,
  normalizeBarOptions,
  normalizeProgressText,
  normalizeRefreshMs,
  normalizeTreeTheme,
  normalizeVisibilityOptions,
  oneLineText,
  progressLabel,
  scopeEntries,
  subagentPrefix,
  subagentTypeLabel,
  visibleEntries,
  INDICATOR_STYLE_CHOICES,
  THEME_PRESET_CHOICES,
  indicatorGlyph,
  indicatorStyleLabel,
  normalizeIndicatorStyle,
  themePresetChoice,
  themePresetFrom,
  themePresetLabel,
  type BarOptions,
  type IndicatorStyle,
  type ThemePreset,
  type TreeTheme,
} from "./tree.js";
import type { ProgressEntry, SayNote, TreeNode } from "./types.js";

type GuiNote = SayNote & { rootSessionId?: string };

type GuiState = {
  entries: Record<string, ProgressEntry>;
  notes: GuiNote[];
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
  if (status === "pending") return "#94a3b8";
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

/** "9:12 AM" clock time for the ultra-compact prefix. */
function formatClock(ms: number | undefined): string {
  if (!ms) return "—";
  try {
    return new Date(ms).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return new Date(ms).toISOString().slice(11, 16);
  }
}

/** Compact duration: "<1m", "42m", "1h 04m", "2d 3h". */
function formatElapsedShort(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Very short age: "just now", "42s ago", "5m ago", "2h ago", "3d ago". */
function formatAgoShort(ms: number | undefined): string {
  if (!ms) return "";
  const delta = Math.max(0, Date.now() - ms);
  if (delta < 10_000) return "just now";
  const seconds = Math.floor(delta / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
  /** Detail line cap: -1 full, 0 hidden, n>0 clamp with ellipsis. Default full. */
  detailLines?: number;
  /** `compact` drops the bar and started line and keeps one detail line. */
  theme?: TreeTheme;
  /** Status indicator family; ultra previously forced emoji circles. */
  indicatorStyle?: IndicatorStyle;
}) {
  const pct = () => progressLabel(props.node.progress);
  const parts = () => barParts(props.node.progress, props.options);
  const compact = () => props.theme === "compact";
  /** Compact rows ignore `guiDetailLines` above 1 but still honor 0 = hidden. */
  const effectiveDetailLines = () =>
    ultra()
      ? rowHovered()
        ? 1
        : 0
      : compact()
        ? (props.detailLines === 0 ? 0 : 1)
        : props.detailLines;
  const ultra = () => props.theme === "ultra-compact";
  const indicatorMode = () => props.indicatorStyle ?? "dot";
  const [rowHovered, setRowHovered] = createSignal(false);
  const compactMeta = () =>
    compactTreeSuffix(
      props.node.progress,
      props.collapsed && props.node.children.length > 0
        ? countDescendants(props.node)
        : 0
    );
  const titleText = () =>
    `${props.depth === 0 ? subagentPrefix(props.node) : ""}${props.node.title}`;
  const subagentTip = () => {
    const type = subagentTypeLabel(props.node);
    return type ? `Subagent type: ${type}` : "";
  };
  const startedAt = () => props.node.startedAt ?? props.node.createdAt;
  const updatedAt = () => props.node.updatedAt ?? props.node.reportedAt;
  const elapsedMs = () => {
    const start = startedAt();
    if (!start) return undefined;
    const terminal = props.node.status === "done" || props.node.status === "error";
    return Math.max(0, (terminal ? updatedAt() ?? Date.now() : Date.now()) - start);
  };
  const timePrefix = () => {
    if (!startedAt()) return "";
    // The row keeps only the last-updated age. Hovering it opens a native tip
    // with the absolute start→end clock and total duration.
    return formatAgoShort(updatedAt());
  };
  const timeTitle = () =>
    `Started ${formatDateTime(startedAt()) || "unknown"} · Updated ${
      formatDateTime(updatedAt()) || "unknown"
    } · Elapsed ${formatElapsedShort(elapsedMs())}`;

  return (
    <div
      onMouseEnter={() => setRowHovered(true)}
      onMouseLeave={() => setRowHovered(false)}
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
        gap: ultra() ? "6px" : "8px",
        "padding-left": `${props.depth * 14}px`,
        "padding-top": ultra() ? "1px" : compact() ? "2px" : "5px",
        "padding-bottom": ultra() ? "1px" : compact() ? "2px" : "5px",
        cursor: props.hasChildren && !props.leaving ? "pointer" : "default",
        transform: props.leaving ? "translateX(120%)" : "translateX(0)",
        opacity: props.leaving ? "0" : "1",
        transition: "transform 0.35s ease-in, opacity 0.3s ease-in",
        "transition-delay": `${props.leaveDelayMs ?? 0}ms`,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          flex: "0 0 auto",
          opacity: props.hasChildren ? "0.6" : "0",
          "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
          "font-size": "9px",
          width: "18px",
          "margin-top": ultra() ? "0" : "4px",
          "user-select": "none",
          "line-height": ultra() ? "16px" : "1",
          display: "inline-block",
          "text-align": "center",
        }}
      >
        {props.hasChildren ? (props.collapsed ? "[+]" : "[-]") : ""}
      </span>
      <Show when={props.depth > 0}>
        <span
          aria-hidden="true"
          style={{
            flex: "0 0 auto",
            "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
            "font-size": "11px",
            "line-height": ultra() ? "16px" : "1",
            "margin-top": ultra() ? "0" : "5px",
            opacity: "0.55",
            "user-select": "none",
            "white-space": "pre",
          }}
        >
          └─
        </span>
      </Show>
      <Show
        when={indicatorMode() === "dot"}
        fallback={
          <span
            aria-label={props.node.status}
            title={props.node.status}
            style={{
              flex: "0 0 auto",
              "font-size": "11px",
              "line-height": ultra() ? "16px" : "1",
              height: ultra() ? "16px" : "auto",
              width: ultra() ? "14px" : "auto",
              display: "inline-flex",
              "align-items": "center",
              "justify-content": "center",
              "user-select": "none",
            }}
          >
            {indicatorGlyph(indicatorMode(), props.node.status)}
          </span>
        }
      >
        <div
          style={{
            width: "8px",
            height: "8px",
            "border-radius": "50%",
            "margin-top": ultra() ? "4px" : "6px",
            flex: "0 0 auto",
            background: dotColor(props.node.status),
          }}
        />
      </Show>
      <div style={{ flex: "1 1 auto", "min-width": "0" }}>
        <div
          style={{
            ...(ultra()
              ? { "font-size": "12px", "font-weight": "400", "line-height": "16px" }
              : { "font-weight": props.depth === 0 ? "650" : "500" }),
            "white-space": ultra() ? "nowrap" : "normal",
            "overflow-wrap": ultra() ? "normal" : "anywhere",
            "word-break": ultra() ? "normal" : "break-word",
            ...(ultra() ? { overflow: "hidden", "text-overflow": "ellipsis" } : {}),
          }}
          title={
            ultra()
              ? [
                  `${props.node.status}: ${oneLineText(titleText())}`,
                  props.node.detail ? normalizeProgressText(props.node.detail) : "",
                  subagentTip(),
                  timeTitle(),
                ]
                  .filter(Boolean)
                  .join("\n\n")
              : `${props.node.status}: ${oneLineText(titleText())}${
                  subagentTip() ? ` — ${subagentTip()}` : ""
                }`
          }
        >
          <Show when={ultra()}>
            <span
              title={timeTitle()}
              style={{
                "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace",
                "font-size": "9px",
                "font-weight": "400",
                "line-height": "16px",
                opacity: "0.5",
                width: "48px",
                display: "inline-block",
                "text-align": "left",
                "margin-right": "6px",
                "white-space": "nowrap",
                "overflow": "hidden",
                cursor: "default",
              }}
            >
              {timePrefix()}
            </span>
          </Show>
          <Show when={ultra()} fallback={<Multiline text={titleText()} />}>
            {oneLineText(titleText())}
          </Show>
        </div>
        <Show when={ultra()}>
          <Show when={props.node.detail}>
            <div
              style={{
                display: "grid",
                "grid-template-rows": rowHovered() ? "1fr" : "0fr",
                opacity: rowHovered() ? "1" : "0",
                transition:
                  "grid-template-rows 0.3s ease-in-out, opacity 0.3s ease-in-out",
                overflow: "hidden",
              }}
            >
              <div style={{ "min-height": "0", overflow: "hidden" }}>
                <div
                  style={{
                    "margin-top": "1px",
                    "font-size": "10px",
                    opacity: "0.58",
                    "white-space": "normal",
                    "overflow-wrap": "anywhere",
                    "word-break": "break-word",
                    display: "-webkit-box",
                    "-webkit-box-orient": "vertical",
                    "-webkit-line-clamp": "1",
                    "text-overflow": "ellipsis",
                    overflow: "hidden",
                  }}
                  title={
                    props.node.detail
                      ? `${props.node.status}: ${oneLineText(props.node.detail)}`
                      : ""
                  }
                >
                  <Multiline text={props.node.detail ?? ""} />
                </div>
              </div>
            </div>
          </Show>
        </Show>
        <Show when={!ultra() && props.node.detail && effectiveDetailLines() !== 0}>
          <div
            style={{
              "margin-top": "2px",
              "font-size": "12px",
              opacity: "0.72",
              "white-space": "normal",
              "overflow-wrap": "anywhere",
              "word-break": "break-word",
              ...((effectiveDetailLines() ?? 0) > 0
                ? {
                    display: "-webkit-box",
                    "-webkit-box-orient": "vertical",
                    "-webkit-line-clamp": String(effectiveDetailLines()),
                    "text-overflow": "ellipsis",
                    overflow: "hidden",
                  }
                : {}),
            }}
            title={props.node.detail ? `${props.node.status}: ${oneLineText(props.node.detail)}` : ""}
          >
            <Multiline text={props.node.detail ?? ""} />
          </div>
        </Show>
        <Show when={!ultra()}>
        <Show
          when={compact()}
          fallback={
            <>
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
                <Show when={props.node.progress != null}>
                  <span style={{ "font-family": "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                    {parts().bar}
                  </span>
                  <Show when={pct()}>
                    <span>{pct()}</span>
                  </Show>
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
            </>
          }
        >
          <Show when={compactMeta()}>
            <div
              style={{
                "margin-top": "2px",
                display: "flex",
                gap: "8px",
                "align-items": "center",
                "font-size": "11px",
                opacity: "0.58",
              }}
            >
              <span>{compactMeta()}</span>
            </div>
          </Show>
        </Show>
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
            width: ultra() ? "18px" : "22px",
            height: ultra() ? "18px" : "22px",
            "margin-top": ultra() ? "-1px" : "0",
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

function rowFor(
  node: TreeNode,
  depth: number,
  options: BarOptions,
  theme: TreeTheme = "default"
) {
  const parts = barParts(node.progress, options);
  const indent = depth > 0 ? "\u00A0\u00A0".repeat(depth) + "└─ " : "";
  const compactSuffix = compactTreeSuffix(node.progress, 0);
  const suffix =
    theme === "ultra-compact"
      ? ""
      : theme === "compact"
        ? compactSuffix
          ? ` · ${compactSuffix}`
          : ""
        : parts.style === "emoji"
          ? `: ${parts.bar}${parts.fraction}`
          : progressLabel(node.progress)
            ? ` · ${progressLabel(node.progress)}`
            : "";
  return {
    id: node.key,
    label: `${indent}${oneLineText(node.title)}${suffix}`,
    detail: theme === "ultra-compact" ? undefined : node.detail ? oneLineText(node.detail) : undefined,
    tone: toneFor(node.status),
  };
}

export default Plugin.define({
  setup(ctx) {
    const [state, setState] = createSignal<GuiState>({ entries: {}, notes: [], loaded: false });
    const [interacting, setInteracting] = createSignal(false);
    let suspendUntil = 0;
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
    const visibility = normalizeVisibilityOptions(ctx.options);
    const refreshMs = normalizeRefreshMs(ctx.options);
    // Placement is memory-backed like the TUI's `tuiLayout`; the configured
    // value seeds it and the palette command / pill action flips it at runtime.
    const [layoutStore, updateLayout] = ctx.storage.memory("guiLayout", {
      initial: { mode: normalizeGuiLayout(ctx.options?.guiLayout) },
    });
    const layoutMode = (): GuiLayout => layoutStore.mode;
    const setLayoutMode = (mode: GuiLayout) =>
      updateLayout((draft) => {
        draft.mode = mode;
      });
    const sidebarWidth = normalizeGuiSidebarWidth(ctx.options?.guiSidebarWidth);
    const detailLines = normalizeGuiDetailLines(ctx.options?.guiDetailLines);
    // Runtime theme preset; the configured tree theme + bar style seed it and
    // the palette command updates it, then persists both to the OpenCode config.
    const [themeStore, updateTheme] = ctx.storage.memory("guiTheme", {
      initial: {
        treeTheme: normalizeTreeTheme(ctx.options?.treeTheme),
        barStyle: normalizeBarOptions(ctx.options).style ?? "blocks",
      },
    });
    const treeTheme = (): TreeTheme => themeStore.treeTheme;
    const [indicatorStore, updateIndicator] = ctx.storage.memory("guiIndicatorStyle", {
      initial: {
        value: normalizeIndicatorStyle(
          ctx.options?.indicatorStyle,
          themeStore.treeTheme === "ultra-compact" ? "circles" : "dot"
        ),
      },
    });
    const indicatorStyle = (): IndicatorStyle => indicatorStore.value;
    const chooseIndicatorStyle = async () => {
      const choice = await ctx.dialogs.select<IndicatorStyle>({
        title: "Progress indicator style",
        current: indicatorStyle(),
        options: INDICATOR_STYLE_CHOICES.map((option) => ({
          title: option.title,
          value: option.value,
          description:
            option.value === indicatorStyle()
              ? `${option.description} · current`
              : option.description,
        })),
      });
      if (!choice) return;
      updateIndicator((draft) => {
        draft.value = choice;
      });
      try {
        const result = await withTimeout(
          ctx.client.rpc(ProgressRpc).setIndicatorStyle({ indicatorStyle: choice }),
          4000
        );
        ctx.toast.show({
          title: `Indicator style: ${indicatorStyleLabel(choice)}`,
          description: result.ok
            ? `Saved to ${result.file}`
            : `Applied for this run; config not updated: ${result.error ?? "unknown error"}`,
          variant: result.ok ? "success" : "default",
          duration: result.ok ? 2500 : 5000,
        });
      } catch (error) {
        ctx.toast.show({
          title: `Indicator style: ${indicatorStyleLabel(choice)}`,
          description: `Applied for this run; config not updated: ${String(error)}`,
          variant: "default",
          duration: 5000,
        });
      }
    };
    const currentPreset = (): ThemePreset =>
      themePresetFrom(themeStore.treeTheme, themeStore.barStyle);
    const setThemePreset = (value: ThemePreset) => {
      const preset = themePresetChoice(value);
      updateTheme((draft) => {
        draft.treeTheme = preset.treeTheme;
        draft.barStyle = preset.barStyle;
      });
    };
    // Bar options follow the runtime preset so a style switch redraws rows
    // without a plugin reload.
    const options = createMemo(() =>
      normalizeBarOptions({ ...ctx.options, barStyle: themeStore.barStyle })
    );
    const sidebarPanelKey = `${ctx.id}:${GUI_PROGRESS_PANEL_ID}`;
    let alive = true;
    let inFlight = false;

    /** Flip between the composer pill and the pinned side-region panel. */
    const swapLayout = () => {
      const next = nextGuiLayout(layoutMode());
      setLayoutMode(next);
      if (next === "sidebar") {
        const session = ctx.sessions.current();
        if (session) {
          ctx.layout.open(sidebarPanelKey, session, { tab: "select", background: true });
        }
      }
      ctx.toast.show({
        title:
          next === "sidebar"
            ? "Progress moved to the sidebar"
            : "Progress moved above the prompt",
        variant: "default",
        duration: 2500,
      });
    };

    /** Pick a theme preset, apply it now, and save it to the OpenCode config. */
    const switchTreeTheme = async () => {
      const current = currentPreset();
      const choice = await ctx.dialogs.select<ThemePreset>({
        title: "Progress tree theme",
        current,
        options: THEME_PRESET_CHOICES.map((option) => ({
          title: option.title,
          value: option.value,
          description:
            option.value === current
              ? `${option.description} · current`
              : option.description,
        })),
      });
      if (!choice) return;
      const preset = themePresetChoice(choice);
      setThemePreset(choice);
      try {
        const result = await ctx.client.rpc(ProgressRpc).setTreeTheme({
          theme: preset.treeTheme,
          barStyle: preset.barStyle,
        });
        ctx.toast.show({
          title: `Progress theme: ${themePresetLabel(choice)}`,
          description: result.ok
            ? `Saved to ${result.file}`
            : `Applied for this run; config not updated: ${result.error ?? "unknown error"}`,
          variant: result.ok ? "success" : "default",
          duration: result.ok ? 2500 : 5000,
        });
      } catch (error) {
        ctx.toast.show({
          title: `Progress theme: ${themePresetLabel(choice)}`,
          description: `Applied for this run; config not updated: ${String(error)}`,
          variant: "default",
          duration: 5000,
        });
      }
    };

    // A configured sidebar must be visible on startup, not just add a pinned
    // tab to a closed region. Open it once per session; closing it later stays
    // closed until the user asks again.
    const sidebarOpenedFor = new Set<string>();
    createEffect(() => {
      if (layoutMode() !== "sidebar") return;
      const session = ctx.sessions.current();
      if (!session || sidebarOpenedFor.has(session.key)) return;
      sidebarOpenedFor.add(session.key);
      if (!ctx.layout.side.opened(session)) {
        ctx.layout.open(sidebarPanelKey, session, { tab: "select", background: true });
      }
    });
    let lastRevision = "";
    let lastRevisionSession = "";

    /**
     * The host's `rpc(contract)` is typed as an untyped client in this
     * environment; give the handful of methods we call their real shapes.
     */
    type ProgressClient = {
      list(input?: {
        sessionID?: string;
        scope?: "session" | "all";
      }): Promise<{
        entries?: Record<string, ProgressEntry>;
        notes?: GuiNote[];
        revision?: string;
      }>;
      dismiss(input: { key: string; status: string }): Promise<{ ok: boolean }>;
      dismissNote(input: { noteID: string }): Promise<{ ok: boolean }>;
      clearNotes(input: { sessionID: string }): Promise<{ ok: boolean; removed: number }>;
      clear(input: { sessionID: string }): Promise<{ ok: boolean; cleared: number }>;
      hardClearSession(input: {
        sessionID: string;
      }): Promise<{ ok: boolean; removed: number; freedBytes: number }>;
      hardClearAll(input?: Record<string, never>): Promise<{
        ok: boolean;
        removed: number;
        freedBytes: number;
      }>;
      stats(input?: { sessionID?: string }): Promise<{
        entries: number;
        active: number;
        done: number;
        error: number;
        dismissed: number;
        cleared: number;
        bytes: number;
      }>;
      nudgeList(input: { sessionID: string }): Promise<{
        rules: Array<{
          id: string;
          title?: string;
          scope: "global" | "project" | "session";
          enabled: boolean;
          text: string;
          severity: "info" | "warn" | "block";
          delivery: string;
          trigger: string;
          criteria: string;
          ttlMs: number;
          maxFires: number;
          fires: number;
          nextFireAt: number;
          effective: boolean;
        }>;
        errors: string[];
      }>;
      nudgeSet(input: {
        sessionID: string;
        preset?: "replace" | "alongside" | "block" | "custom";
        rule: Record<string, unknown>;
      }): Promise<{ ok: boolean; error?: string }>;
      nudgeSetEnabled(input: {
        sessionID: string;
        scope: "global" | "project" | "session";
        id: string;
        enabled: boolean;
      }): Promise<{ ok: boolean; error?: string }>;
      nudgeClear(input: {
        sessionID: string;
        scope: "global" | "project" | "session";
        id: string;
      }): Promise<{ ok: boolean; error?: string }>;
      nudgeTelemetry(input: { sessionID: string; limit?: number }): Promise<{
        engine: "legacy" | "shadow" | "shared";
        mutedUntil: number;
        standing: { severity: string; source: string; text: string; at: number };
        fires: number;
        lastReminderAt: number;
        lastProgressAt: number;
        gapMs: number;
        graceMs: number;
        capPerSession: number;
        entryView: Record<string, string>;
        health: {
          bySource: Record<string, number>;
          rejects: Record<string, number>;
          compliance: { samples: number; medianMs: number; p90Ms: number };
        };
        logBytes: number;
        events: Array<Record<string, unknown>>;
        counts: Record<string, number>;
      }>;
      nudgeMute(input: {
        sessionID: string;
        minutes?: number;
      }): Promise<{ ok: boolean; mutedUntil: number }>;
      nudgePurge(input: { sessionID: string }): Promise<{ ok: boolean }>;
      setIndicatorStyle(input: {
        indicatorStyle: "dot" | "circles" | "checkbox";
      }): Promise<{
        ok: boolean;
        indicatorStyle: "dot" | "circles" | "checkbox";
        file?: string;
        error?: string;
      }>;
    };
    const rpcFor = (session: MountedSession) =>
      session.server.client.rpc(ProgressRpc) as unknown as ProgressClient;
    const globalRpc = () =>
      ctx.client.rpc(ProgressRpc) as unknown as ProgressClient;

    type TaskListViewStatus = {
      enabled: boolean;
      mode: "ui" | "raw";
      detail: "code" | "escaped" | "raw";
      location: 0 | 1 | 2;
      order: "newest-first" | "oldest-first";
    };
    const [taskListStatus, setTaskListStatus] = createSignal<TaskListViewStatus | null>(null);
    const refreshTaskListStatus = async () => {
      try {
        const status = await withTimeout(ctx.client.rpc(ProgressRpc).taskListStatus({}), 4000);
        if (!alive) return;
        setTaskListStatus(status as TaskListViewStatus);
      } catch {
        // Status is optional; the mirror may simply be disabled.
      }
    };
    void refreshTaskListStatus();
    const taskListTimer = setInterval(() => void refreshTaskListStatus(), 10_000);

    const sayNotesEnabled = ctx.options?.say === true;
    const sayOptions = normalizeSayOptions(ctx.options);
    const sayModes = sayOptions.modes;
    const autoHideTimeoutMs = sayOptions.autoHideTimeoutMs;
    const saySurfaces = () => guiSaySurfaces(sayModes, layoutMode());
    // Notes expire by wall clock, but the GUI only refreshes on state changes.
    // This clock re-renders the note surfaces only while notes exist.
    const [notesClock, setNotesClock] = createSignal(Date.now());
    let notesClockTimer: ReturnType<typeof setInterval> | undefined;
    createEffect(() => {
      const hasNotes = state().notes.length > 0;
      if (hasNotes && !notesClockTimer) {
        notesClockTimer = setInterval(() => setNotesClock(Date.now()), 1000);
      } else if (!hasNotes && notesClockTimer) {
        clearInterval(notesClockTimer);
        notesClockTimer = undefined;
      }
    });
    // Optimistic note removals between the click and the next server state.
    // Note ids are stable, so a removed id stays filtered until it disappears
    // from the shared ring buffer.
    const [pendingNoteDismissals, setPendingNoteDismissals] = createSignal<
      Record<string, number>
    >({});
    /** Per-session note ids already seen; the first load primes without toasts. */
    const seenNotesBySession = new Map<string, Set<string>>();

    /** Notes rolled up to this session's root, newest first. */
    const notesForSession = (sessionID: string, all: GuiNote[] = state().notes) => {
      const pending = pendingNoteDismissals();
      const scoped = all.filter(
        (note) =>
          !pending[note.id] &&
          (note.rootSessionId ?? note.sessionId) === sessionID
      );
      return visibleSayNotes(scoped, notesClock(), autoHideTimeoutMs).slice(0, 20);
    };

    /**
     * Toast notes that appeared after this session was first loaded. The
     * baseline is per session, so switching chats never replays old history.
     */
    const toastFreshNotes = (sessionID: string, all: GuiNote[]) => {
      if (!saySurfaces().toast) return;
      const notes = notesForSession(sessionID, all);
      const current = new Set(notes.map((note) => note.id));
      const seen = seenNotesBySession.get(sessionID);
      if (!seen) {
        seenNotesBySession.set(sessionID, current);
        return;
      }
      const pendingRemovals = pendingNoteDismissals();
      for (const id of [...seen]) {
        // Keep ids that are merely awaiting the server's dismiss write; only
        // forget notes that are truly gone (prevents a re-toast race).
        if (!current.has(id) && !pendingRemovals[id]) seen.delete(id);
      }
      const toastable = new Set(
        sayToastNotes(notes, sessionID, sayOptions.toastScope).map((note) => note.id)
      );
      const fresh = notes
        .filter((note) => !seen.has(note.id) && toastable.has(note.id))
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      for (const note of notes) seen.add(note.id);
      for (const note of fresh) {
        const toast = buildNoteToast(note, sessionID);
        // The desktop toast API has no `warning` variant; use its warning
        // icon with the neutral tone for blocked/question notes.
        ctx.toast.show({
          title: toast.title,
          description: toast.description,
          variant: "default",
          ...(toast.tone === "warning" ? { icon: "warning" as const } : {}),
          duration: sayToastDurationMs(note.kind),
        });
      }
    };

    const refresh = async () => {
      if (inFlight || interacting() || Date.now() < suspendUntil) return;
      inFlight = true;
      try {
        const session = ctx.sessions.current();
        if (!session) {
          setState((prev) => ({ ...prev, notes: [], loaded: true }));
          return;
        }
        const result = await withTimeout(
          rpcFor(session).list({ scope: "all", sessionID: session.id }),
          4000
        );
        if (!alive) return;
        if (session.id !== lastRevisionSession) {
          lastRevision = "";
          lastRevisionSession = session.id;
        }
        const revision = typeof result?.revision === "string" ? result.revision : "";
        if (revision && revision === lastRevision) return;
        if (revision) lastRevision = revision;
        const entries = (result?.entries ?? {}) as Record<string, ProgressEntry>;
        const notes = (result?.notes ?? []) as GuiNote[];
        // Drop optimistic dismissals once the persisted state reflects them.
        // Build the next map first so an unchanged poll does not notify every
        // dependent computation a second time.
        const prevPending = pendingDismissed();
        const nextPending = { ...prevPending };
        let pendingChanged = false;
        for (const [key, value] of Object.entries(prevPending)) {
          const d = entries[key]?.dismissed;
          if (d && typeof d === "object" && (d as { at: number }).at >= value.at - 500) {
            delete nextPending[key];
            pendingChanged = true;
          }
        }
        // Drop optimistic note removals once the shared ring buffer no longer
        // contains them (the server processed the dismiss/clear).
        const prevNotePending = pendingNoteDismissals();
        const nextNotePending = { ...prevNotePending };
        let notePendingChanged = false;
        const liveNoteIDs = new Set(notes.map((note) => note.id));
        for (const id of Object.keys(prevNotePending)) {
          if (!liveNoteIDs.has(id)) {
            delete nextNotePending[id];
            notePendingChanged = true;
          }
        }
        batch(() => {
          setState({ entries, notes, loaded: true });
          if (pendingChanged) setPendingDismissed(nextPending);
          if (notePendingChanged) setPendingNoteDismissals(nextNotePending);
        });
        toastFreshNotes(session.id, notes);

      } catch (error) {
        if (!alive) return;
        setState((prev) => ({ ...prev, loaded: true, error: String(error) }));
        console.error("[opencode-progress] rpc list failed", String(error));
      } finally {
        inFlight = false;
      }
    };

    console.log(`[opencode-progress] gui setup v${displayVersion} (opencode ${ctx.app.version}, ${ctx.app.platform})`);
    if (ctx.options?.notifyOnLoad === true) {
      ctx.toast.show({
        title: "Progress plugin loaded",
        description: `${ctx.app.platform} · opencode-progress v${displayVersion}`,
        variant: "success",
        duration: 2500,
      });
    }
    void refresh();
    let unsubscribeUpdated: (() => void) | undefined;
    try {
      // The server emits this whenever its state signature changes. Polling
      // stays as a slow fallback for a missed event or a server restart.
      unsubscribeUpdated = ctx.client
        .rpc(ProgressRpc)
        .events.on("updated", () => void refresh());
    } catch (error) {
      console.warn("[opencode-progress] updated subscription unavailable", String(error));
    }
    const timer = setInterval(
      () => void refresh(),
      unsubscribeUpdated ? Math.max(refreshMs, 5000) : refreshMs
    );

    /** Persisted dismissals, read straight from the state doc entries. */
    const dismissedFromEntries = (
      entries: Record<string, ProgressEntry> = state().entries
    ) => {
      const map: Record<string, { status: string; at: number }> = {};
      for (const [key, entry] of Object.entries(entries)) {
        const d = entry.dismissed;
        if (d && typeof d === "object" && typeof d.at === "number") {
          map[key] = { status: String(d.status ?? ""), at: d.at };
        }
      }
      return map;
    };

    /** Persisted + optimistic: pending wins while newer than persisted. */
    const dismissedMap = (entries: Record<string, ProgressEntry> = state().entries) => {
      const merged = dismissedFromEntries(entries);
      for (const [key, pending] of Object.entries(pendingDismissed())) {
        const persisted = merged[key];
        if (!persisted || pending.at > persisted.at) merged[key] = pending;
      }
      return merged;
    };

    /** Persist the dismissal via the plugin server, optimistically in-memory. */
    const dismissKey = (
      session: MountedSession,
      key: string,
      status: string
    ) => {
      setPendingDismissed((prev) => ({ ...prev, [key]: { status, at: Date.now() } }));
      void rpcFor(session)
        .dismiss({ key, status })
        .catch((error: unknown) =>
          console.error("[opencode-progress] dismiss rpc failed", String(error))
        );
    };

    const sessionEntries = (sessionID: string) =>
      Object.entries(state().entries).filter(
        ([key, entry]) =>
          entry &&
          typeof entry === "object" &&
          (entry.sessionId === sessionID || key.startsWith(`${sessionID}:`))
      );

    /** Palette-only: soft-clear finished/dismissed entries for this session. */
    const clearList = async () => {
      const session = ctx.sessions.current();
      if (!session) {
        ctx.toast.show({ title: "Open a session first", variant: "error" });
        return;
      }
      const candidates = sessionEntries(session.id).filter(
        ([, entry]) =>
          !entry.cleared &&
          (entry.status === "done" ||
            entry.status === "error" ||
            Boolean(entry.dismissed))
      );
      if (candidates.length === 0) {
        ctx.toast.show({ title: "Nothing to clear", description: "No finished or dismissed entries.", variant: "default" });
        return;
      }
      const confirmed = await ctx.dialogs.confirm({
        title: "Clear progress list?",
        description: `${candidates.length} finished or dismissed ${
          candidates.length === 1 ? "entry" : "entries"
        } will be hidden. Records stay on disk; running tasks keep showing.`,
        confirm: "Clear list",
        danger: true,
      });
      if (!confirmed) return;
      try {
        const result = await rpcFor(session).clear({ sessionID: session.id });
        setInteracting(false);
        void refresh();
        ctx.toast.show({
          title: "Progress list cleared",
          description: `${result.cleared} ${
            result.cleared === 1 ? "entry" : "entries"
          } hidden; records kept.`,
          variant: "success",
        });
      } catch (error) {
        ctx.toast.show({
          title: "Clear failed",
          description: String(error),
          variant: "error",
        });
      }
    };

    /** Palette-only: permanently delete this session's progress entries. */
    const hardClearSession = async () => {
      const session = ctx.sessions.current();
      if (!session) {
        ctx.toast.show({ title: "Open a session first", variant: "error" });
        return;
      }
      try {
        const stats = await rpcFor(session).stats({ sessionID: session.id });
        if (stats.entries === 0) {
          ctx.toast.show({ title: "Nothing to delete", variant: "default" });
          return;
        }
        const confirmed = await ctx.dialogs.confirm({
          title: "Permanently delete session progress?",
          description: `${stats.entries} ${
            stats.entries === 1 ? "entry" : "entries"
          } (${formatBytes(stats.bytes)}) will be removed from the progress store. The mirrored tasklist file is kept. This cannot be undone.`,
          confirm: "Delete permanently",
          danger: true,
        });
        if (!confirmed) return;
        const result = await rpcFor(session).hardClearSession({
          sessionID: session.id,
        });
        setInteracting(false);
        void refresh();
        ctx.toast.show({
          title: "Session progress deleted",
          description: `${result.removed} ${
            result.removed === 1 ? "entry" : "entries"
          } removed · ${formatBytes(result.freedBytes)} freed.`,
          variant: "success",
        });
      } catch (error) {
        ctx.toast.show({
          title: "Delete failed",
          description: String(error),
          variant: "error",
        });
      }
    };

    /** Palette-only: wipe every progress entry. Requires typing DELETE. */
    const hardClearStore = async () => {
      try {
        const stats = await globalRpc().stats({});
        if (stats.entries === 0) {
          ctx.toast.show({ title: "Progress store is already empty", variant: "default" });
          return;
        }
        const typed = await ctx.dialogs.prompt({
          title: "Hard clear the entire progress store",
          description: `This deletes all ${stats.entries} entries (${formatBytes(
            stats.bytes
          )}) from the plugin store. It cannot be undone without a backup and prevents future auditing or progress reporting. Type DELETE to confirm.`,
          placeholder: "DELETE",
          submit: "Delete everything",
        });
        if (typed?.trim() !== "DELETE") {
          if (typed !== undefined) {
            ctx.toast.show({ title: "Store not cleared", description: "Confirmation did not match.", variant: "default" });
          }
          return;
        }
        const result = await globalRpc().hardClearAll({});
        setInteracting(false);
        void refresh();
        ctx.toast.show({
          title: "Progress store cleared",
          description: `${result.removed} ${
            result.removed === 1 ? "entry" : "entries"
          } removed · ${formatBytes(result.freedBytes)} freed. Mirrored tasklists kept.`,
          variant: "success",
        });
      } catch (error) {
        ctx.toast.show({
          title: "Hard clear failed",
          description: String(error),
          variant: "error",
        });
      }
    };

    ctx.add(Command, () => ({
      id: "progress.clear",
      title: "Progress: clear list (this session)",
      description: "Hide finished and dismissed entries; records stay on disk",
      keywords: "progress clear soft delete dismiss history",
      section: "session" as const,
      get enabled() {
        return Boolean(ctx.sessions.current());
      },
      run: () => void clearList(),
    }));

    ctx.add(Command, () => ({
      id: "progress.hard-clear-session",
      title: "Progress: hard clear this session",
      description: "Permanently delete this session's progress entries",
      keywords: "progress hard delete purge session store",
      section: "session" as const,
      get enabled() {
        return Boolean(ctx.sessions.current());
      },
      run: () => void hardClearSession(),
    }));

    ctx.add(Command, () => ({
      id: "progress.hard-clear-store",
      title: "Progress: hard clear entire progress store",
      description: "Delete all progress entries; requires typing DELETE",
      keywords: "progress hard delete purge all store wipe",
      section: "general" as const,
      run: () => void hardClearStore(),
    }));

    ctx.add(
      Style,
      `.progress-pill-button { cursor: pointer !important; }
       .progress-pill-button:hover { background: rgba(127,127,127,0.18) !important; }`
    );

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

    /**
     * Read-only settings tab for the pill popover and sidebar. Values are the
     * effective runtime options; edits belong in the OpenCode config that
     * declares the plugin and apply on reload.
     */
    const SettingsGroup = (props: { title: string; children?: unknown }) => (
      <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
        <div
          style={{
            "font-size": "10px",
            "text-transform": "uppercase",
            "letter-spacing": "0.04em",
            opacity: "0.45",
          }}
        >
          {props.title}
        </div>
        {props.children as never}
      </div>
    );

    const SettingsRow = (props: { label: string; value: string }) => (
      <div
        style={{
          display: "flex",
          "align-items": "baseline",
          gap: "8px",
          "font-size": "11px",
          "line-height": "1.35",
        }}
      >
        <span style={{ flex: "0 0 96px", opacity: "0.55" }}>{props.label}</span>
        <span
          style={{
            flex: "1 1 auto",
            "min-width": "0",
            overflow: "hidden",
            "text-overflow": "ellipsis",
            "white-space": "nowrap",
          }}
          title={props.value}
        >
          {props.value}
        </span>
      </div>
    );

    /**
     * Read-only settings tab for the pill popover and sidebar. Values are the
     * effective runtime options; edits belong in the OpenCode config that
     * declares the plugin and apply on reload.
     */
    const SettingsPanel = (props: { onBack: () => void }) => {
      const linkStyle = {
        border: "none",
        background: "transparent",
        color: "inherit",
        cursor: "pointer",
        padding: "0",
        "font-size": "10px",
        "text-decoration": "underline",
        opacity: "0.75",
      } as const;

      return (
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "6px",
            "min-height": "260px",
            "min-width": "260px",
            "max-height": "min(60vh, 520px)",
            "overflow-y": "auto",
          }}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "6px",
              "padding-bottom": "6px",
              "border-bottom": "1px solid rgba(127,127,127,0.2)",
              "flex": "0 0 auto",
            }}
          >
            <span style={{ flex: "1 1 auto", "font-size": "12px", opacity: "0.75" }}>
              Plugin settings
            </span>
            <button
              type="button"
              class="progress-pill-button"
              onClick={props.onBack}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              [Tree]
            </button>
          </div>
          <div style={{ display: "flex", "flex-direction": "column", gap: "8px", "padding-right": "4px" }}>
            <SettingsGroup title="View">
              <SettingsRow label="Placement" value={layoutMode()} />
              <SettingsRow label="Tree theme" value={treeTheme()} />
              <SettingsRow label="Indicator" value={indicatorStyleLabel(indicatorStyle())} />
              <SettingsRow label="Bar style" value={themeStore.barStyle} />
              <SettingsRow label="Detail lines" value={String(detailLines)} />
              <SettingsRow label="Refresh" value={`${refreshMs}ms`} />
              <SettingsRow
                label="Done entries"
                value={
                  visibility.showDone
                    ? visibility.autoHideDone
                      ? "auto-hide"
                      : "shown"
                    : "hidden"
                }
              />
              <SettingsRow
                label="Expand roots"
                value={ctx.options?.expandRootsByDefault === true ? "yes" : "no"}
              />
            </SettingsGroup>
            <SettingsGroup title="Reminders">
              <SettingsRow label="Strict mode" value={String(ctx.options?.strictMode ?? "nudge")} />
              <SettingsRow
                label="Wall clock"
                value={`${Math.round(
                  (typeof ctx.options?.wallClockMs === "number"
                    ? ctx.options.wallClockMs
                    : 600_000) / 1000
                )}s`}
              />
              <SettingsRow
                label="Idle reminder"
                value={ctx.options?.idleReminder === false ? "off" : "on"}
              />
              <SettingsRow
                label="Relay hints"
                value={ctx.options?.relayHints === false ? "off" : "on"}
              />
              <SettingsRow
                label="Custom nudges"
                value={ctx.options?.customNudges === true ? "on" : "off (opt-in)"}
              />
              <SettingsRow label="Say notes" value={ctx.options?.say === true ? "on" : "off"} />
              <SettingsRow
                label="Say surfaces"
                value={sayModes.length > 0 ? sayModes.join(", ") : "none"}
              />
            </SettingsGroup>
            <SettingsGroup title="Data">
              <SettingsRow label="Scope" value={visibility.scope} />
              <SettingsRow
                label="Task-list mirror"
                value={taskListStatus()?.enabled ? taskListStatus()?.mode ?? "on" : "off"}
              />
              <SettingsRow label="Workspace" value={ctx.location?.directory ?? "unknown"} />
            </SettingsGroup>
          </div>
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "10px",
              "padding-top": "4px",
              "border-top": "1px solid rgba(127,127,127,0.2)",
              "font-size": "10px",
              opacity: "0.6",
              "flex": "0 0 auto",
            }}
          >
            <button
              type="button"
              class="progress-pill-button"
              style={linkStyle}
              onClick={() => ctx.system.openExternal(releasesUrl())}
            >
              v{displayVersion} release notes ↗
            </button>
            <button
              type="button"
              class="progress-pill-button"
              style={linkStyle}
              onClick={() => ctx.system.openExternal("https://github.com/jakedowns/progress-tool#readme")}
            >
              Docs ↗
            </button>
          </div>
          <div style={{ "font-size": "10px", opacity: "0.45", "flex": "0 0 auto" }}>
            Edit these in the OpenCode config that declares the plugin; reload to apply.
          </div>
        </div>
      );
    };

    const sidebarHeaderButtonStyle = {
      flex: "0 0 auto",
      border: "1px solid rgba(127,127,127,0.35)",
      background: "transparent",
      color: "inherit",
      opacity: "0.7",
      "border-radius": "999px",
      padding: "1px 8px",
      cursor: "pointer",
      "font-size": "11px",
      "white-space": "nowrap",
    };

    const ProgressMenu = (props: {
      session: MountedSession;
      sessionID: string;
      close?: () => void;
    }) => {
      // The popover removes this component without a pointerleave; make sure
      // closing it never leaves refresh paused forever.
      onCleanup(() => setInteracting(false));
      const [view, setView] = createSignal<"tree" | "settings">("tree");
      const scoped = createMemo(() =>
        scopeEntries(state().entries, props.sessionID, visibility)
      );
      // Persisted + optimistic dismissals, recomputed once per state change
      // rather than once per root. The old per-root call scanned every entry
      // in the store for every root, which dominated the 1 s tick.
      const dismissed = createMemo(() => {
        const merged = dismissedFromEntries(scoped());
        for (const [key, pending] of Object.entries(pendingDismissed())) {
          const persisted = merged[key];
          if (!persisted || pending.at > persisted.at) merged[key] = pending;
        }
        return merged;
      });
      const tree = createMemo(() =>
        buildVisibleTree(scoped(), Date.now(), visibility, dismissed())
      );
      const visibleRoots = createMemo(() => tree());
      const [expandedOverrides, setExpandedOverrides] = createSignal<Record<string, boolean>>({});
      const expandByDefault = ctx.options?.expandRootsByDefault === true;
      const collapsedMap = createMemo(() =>
        collapsedRootMap(visibleRoots(), expandByDefault, expandedOverrides())
      );
      const rows = createMemo(() => visibleRows(visibleRoots(), collapsedMap()));
      const doneRoots = createMemo(() =>
        visibleRoots().filter((root) => root.status === "done")
      );
      // Stable keys keep <For> from remounting every row on each poll. The
      // node lookup is reactive, so row content still updates in place.
      const rootKeys = createMemo(() => visibleRoots().map((root) => root.key));
      const rootByKey = createMemo(() => {
        const map = new Map<string, TreeNode>();
        for (const root of visibleRoots()) map.set(root.key, root);
        return map;
      });

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
        // Do not let a poll land mid-animation and rebuild the rows.
        suspendUntil = Math.max(
          suspendUntil,
          Date.now() + delayMs + SLIDE_MS + COLLAPSE_MS + 120
        );
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

      return (
        <div
          onPointerEnter={() => setInteracting(true)}
          onPointerLeave={() => setInteracting(false)}
          style={{
            display: "flex",
            "flex-direction": "column",
            "min-width": "320px",
            "max-width": "520px",
          }}
        >
          <Show
            when={view() === "tree"}
            fallback={
              <ErrorBoundary
                fallback={(error) => (
                  <div style={{ padding: "8px", "font-size": "12px", color: "#f87171" }}>
                    Settings failed to render: {String(error)}
                  </div>
                )}
              >
                <SettingsPanel onBack={() => setView("tree")} />
              </ErrorBoundary>
            }
          >
          <div
            ref={(el) => (listEl = el)}
            onScroll={(event) => {
              scrollTop = event.currentTarget.scrollTop;
            }}
            style={{
              display: "flex",
              "flex-direction": "column",
              gap: treeTheme() === "ultra-compact" ? "1px" : "2px",
              margin: treeTheme() === "ultra-compact" ? "5px" : "0",
              "flex": "0 1 auto",
              "min-height": "0",
              "max-height": "min(60vh, 520px)",
              "overflow-y": "auto",
              "overflow-x": "hidden",
              "scrollbar-gutter": treeTheme() === "ultra-compact" ? "stable" : "auto",
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
            <For each={rootKeys()}>
              {(key) => {
                const root = () => rootByKey().get(key);
                const isCollapsed = () => collapsedMap()[key] ?? false;
                return (
                  // Outer wrapper collapses vertically once the row has slid
                  // fully past the right edge.
                  <div
                    data-root-key={key}
                    style={{
                      display: "grid",
                      "grid-template-rows": leavingCollapsed()[key] ? "0fr" : "1fr",
                      transition: "grid-template-rows 0.3s ease-in",
                    }}
                  >
                    <Show when={root()}>
                      {(node) => (
                        <div style={{ overflow: "hidden", "min-height": "0" }}>
                          <MenuRow
                            node={node()}
                            depth={0}
                            options={options()}
                            detailLines={detailLines}
                            theme={treeTheme()} indicatorStyle={indicatorStyle()}
                            hasChildren={node().children.length > 0}
                            collapsed={isCollapsed()}
                            onToggle={() =>
                              setExpandedOverrides((prev) => ({
                                ...prev,
                                [key]: !(prev[key] ?? expandByDefault),
                              }))
                            }
                            onDismiss={() => dismissAnimated(node())}
                            leaving={leaving()[key] !== undefined}
                            leaveDelayMs={leaving()[key] ?? 0}
                          />
                          <div
                            style={{
                              display: "grid",
                              "grid-template-rows": isCollapsed() ? "0fr" : "1fr",
                              transition: "grid-template-rows 0.5s ease-in-out, transform 0.35s ease-in, opacity 0.3s ease-in",
                              transform:
                                leaving()[key] !== undefined
                                  ? "translateX(120%)"
                                  : "translateX(0)",
                              opacity: leaving()[key] !== undefined ? "0" : "1",
                              "transition-delay": `${leaving()[key] ?? 0}ms`,
                            }}
                          >
                            <div style={{ overflow: "hidden", "min-height": "0" }}>
                              <For each={flattenTreeWithDepth(node().children, 1)}>
                                {({ node: child, depth }) => (
                                  <MenuRow
                                    node={child}
                                    depth={depth}
                                    options={options()}
                                    detailLines={detailLines}
                                    theme={treeTheme()} indicatorStyle={indicatorStyle()}
                                    onDismiss={() =>
                                      dismissKey(props.session, child.key, child.status ?? "")
                                    }
                                  />
                                )}
                              </For>
                            </div>
                          </div>
                        </div>
                      )}
                    </Show>
                  </div>
                );
              }}
            </For>
          </Show>
          </div>
          </Show>
          <Show when={view() === "tree" && rows().length > 0}>
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
              <Show when={doneRoots().length > 0 && doneRoots().length < visibleRoots().length}>
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
            <span>progress plugin desktop</span>
            <button
              type="button"
              class="progress-pill-button"
              title="Open release notes"
              onClick={() => ctx.system.openExternal(releasesUrl())}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              [v{displayVersion}]
            </button>
            <button
              type="button"
              class="progress-pill-button"
              title="Show plugin settings"
              onClick={() => setView((current) => (current === "settings" ? "tree" : "settings"))}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              {view() === "settings" ? "[Tree]" : "[Settings]"}
            </button>
            <button
              type="button"
              class="progress-pill-button"
              title="Move progress into the sidebar"
              onClick={() => {
                swapLayout();
                props.close?.();
              }}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              [Sidebar]
            </button>
            <button
              type="button"
              class="progress-pill-button"
              onClick={() => ctx.system.openExternal(feedbackIssueUrl(displayVersion))}
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

    /**
     * Full tree for the pinned side-region panel. Unlike the popover it has
     * no height cap of its own; the panel body scrolls, and the header keeps
     * the aggregate summary and a way back to the composer pill.
     */
    const ProgressSidebar = (props: {
      session: () => MountedSession;
      sessionID: () => string;
    }) => {
      const [view, setView] = createSignal<"tree" | "settings">("tree");
      const scoped = createMemo(() =>
        scopeEntries(state().entries, props.sessionID(), visibility)
      );
      const dismissed = createMemo(() => {
        const merged = dismissedFromEntries(scoped());
        for (const [key, pending] of Object.entries(pendingDismissed())) {
          const persisted = merged[key];
          if (!persisted || pending.at > persisted.at) merged[key] = pending;
        }
        return merged;
      });
      const tree = createMemo(() =>
        buildVisibleTree(scoped(), Date.now(), visibility, dismissed())
      );
      const visibleRoots = createMemo(() => tree());
      const [expandedOverrides, setExpandedOverrides] = createSignal<
        Record<string, boolean>
      >({});
      const expandByDefault = ctx.options?.expandRootsByDefault === true;
      const collapsedMap = createMemo(() =>
        collapsedRootMap(visibleRoots(), expandByDefault, expandedOverrides())
      );
      const doneRoots = createMemo(() =>
        visibleRoots().filter((root) => root.status === "done")
      );
      const rootKeys = createMemo(() => visibleRoots().map((root) => root.key));
      const rootByKey = createMemo(() => {
        const map = new Map<string, TreeNode>();
        for (const root of visibleRoots()) map.set(root.key, root);
        return map;
      });
      const summary = createMemo(() => {
        const totals = summarizeEntries(scoped());
        const parts: string[] = [];
        if (totals.active > 0) parts.push(`${totals.active} active`);
        if (totals.pending > 0) parts.push(`${totals.pending} pending`);
        if (totals.done > 0) parts.push(`${totals.done} done`);
        if (totals.dismissed > 0) parts.push(`${totals.dismissed} dismissed`);
        return parts.length > 0 ? parts.join(" · ") : "Agent progress";
      });
      const dismissAll = (roots: TreeNode[]) => {
        for (const root of roots) {
          dismissKey(props.session(), root.key, root.status ?? "");
        }
      };
      const notesLine = createMemo(() => {
        if (!guiSaySurfaces(sayModes, "sidebar").line) return "";
        return buildNotesLine(notesForSession(props.sessionID()), props.sessionID());
      });

      return (
        <div
          style={{
            display: "flex",
            "flex-direction": "column",
            height: "100%",
            "min-height": "0",
            gap: "4px",
          }}
        >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              "padding-bottom": "6px",
              "border-bottom": "1px solid rgba(127,127,127,0.2)",
              "flex": "0 0 auto",
            }}
          >
            <span
              title={summary()}
              style={{
                flex: "1 1 auto",
                "min-width": "0",
                "font-size": "12px",
                opacity: "0.65",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
              }}
            >
              {summary()}
            </span>
            <button
              type="button"
              class="progress-pill-button"
              title="Move progress above the prompt"
              onClick={() => swapLayout()}
              style={sidebarHeaderButtonStyle}
            >
              → Composer
            </button>
          </div>
          <Show when={notesLine()}>
            <div
              title={notesLine()}
              style={{
                "font-size": "11px",
                opacity: "0.62",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
                "flex": "0 0 auto",
              }}
            >
              {notesLine()}
            </div>
          </Show>
          <Show
            when={view() === "tree"}
            fallback={
              <ErrorBoundary
                fallback={(error) => (
                  <div style={{ padding: "8px", "font-size": "12px", color: "#f87171" }}>
                    Settings failed to render: {String(error)}
                  </div>
                )}
              >
                <SettingsPanel onBack={() => setView("tree")} />
              </ErrorBoundary>
            }
          >
          <Show
            when={visibleRoots().length > 0}
            fallback={
              <div
                style={{
                  opacity: "0.6",
                  "font-size": "13px",
                  padding: "8px 2px",
                  "flex": "1 1 auto",
                }}
              >
                No active progress
              </div>
            }
          >
            <div
              style={{
                display: "flex",
                "flex-direction": "column",
                gap: treeTheme() === "ultra-compact" ? "1px" : "2px",
                margin: treeTheme() === "ultra-compact" ? "5px" : "0",
                flex: "1 1 auto",
                "min-height": "0",
                "overflow-y": "auto",
                "overflow-x": "hidden",
                "scrollbar-gutter": treeTheme() === "ultra-compact" ? "stable" : "auto",
                "padding-right": "2px",
              }}
            >
              <For each={rootKeys()}>
                {(key) => {
                  const root = () => rootByKey().get(key);
                  const isCollapsed = () => collapsedMap()[key] ?? false;
                  return (
                    <Show when={root()}>
                      {(node) => (
                        <div>
                          <MenuRow
                            node={node()}
                            depth={0}
                            options={options()}
                            detailLines={detailLines}
                            theme={treeTheme()} indicatorStyle={indicatorStyle()}
                            hasChildren={node().children.length > 0}
                            collapsed={isCollapsed()}
                            onToggle={() =>
                              setExpandedOverrides((prev) => ({
                                ...prev,
                                [key]: !(prev[key] ?? expandByDefault),
                              }))
                            }
                            onDismiss={() =>
                              dismissKey(props.session(), key, node().status ?? "")
                            }
                          />
                          <div
                            style={{
                              display: "grid",
                              "grid-template-rows": isCollapsed() ? "0fr" : "1fr",
                              transition: "grid-template-rows 0.35s ease-in-out",
                            }}
                          >
                            <div style={{ overflow: "hidden", "min-height": "0" }}>
                              <For each={flattenTreeWithDepth(node().children, 1)}>
                                {({ node: child, depth }) => (
                                  <MenuRow
                                    node={child}
                                    depth={depth}
                                    options={options()}
                                    detailLines={detailLines}
                                    theme={treeTheme()} indicatorStyle={indicatorStyle()}
                                    onDismiss={() =>
                                      dismissKey(props.session(), child.key, child.status ?? "")
                                    }
                                  />
                                )}
                              </For>
                            </div>
                          </div>
                        </div>
                      )}
                    </Show>
                  );
                }}
              </For>
            </div>
          </Show>
          </Show>
          <Show when={view() === "tree" && visibleRoots().length > 0}>
            <div
              style={{
                display: "flex",
                gap: "2px",
                "padding-top": "2px",
                "border-top": "1px solid rgba(127,127,127,0.2)",
                "flex": "0 0 auto",
              }}
            >
              <Show when={doneRoots().length > 0 && doneRoots().length < visibleRoots().length}>
                <button
                  type="button"
                  class="progress-pill-button"
                  onClick={() => dismissAll(doneRoots())}
                  style={footerButtonStyle}
                >
                  ✓ Dismiss done ({doneRoots().length})
                </button>
              </Show>
              <button
                type="button"
                class="progress-pill-button"
                onClick={() => dismissAll(visibleRoots())}
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
              "padding": "1px 2px 2px",
              "font-size": "10px",
              opacity: "0.45",
              "user-select": "none",
              "flex": "0 0 auto",
            }}
          >
            <span>progress plugin desktop</span>
            <button
              type="button"
              class="progress-pill-button"
              title="Open release notes"
              onClick={() => ctx.system.openExternal(releasesUrl())}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              [v{displayVersion}]
            </button>
            <button
              type="button"
              class="progress-pill-button"
              title="Show plugin settings"
              onClick={() => setView((current) => (current === "settings" ? "tree" : "settings"))}
              style={{
                ...footerButtonStyle,
                flex: "0 0 auto",
                padding: "0",
                opacity: "1",
                "font-size": "10px",
                "text-decoration": "underline",
              }}
            >
              {view() === "settings" ? "[Tree]" : "[Settings]"}
            </button>
            <button
              type="button"
              class="progress-pill-button"
              onClick={() => ctx.system.openExternal(feedbackIssueUrl(displayVersion))}
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

    const NOTE_RING_RADIUS = 5;
    const NOTE_RING_CIRCUMFERENCE = 2 * Math.PI * NOTE_RING_RADIUS;

    /** Countdown ring for the note's auto-hide expiry. */
    const NoteExpiryRing = (props: { note: GuiNote }) => {
      const remaining = () => {
        if (!(autoHideTimeoutMs > 0)) return 1;
        const at = typeof props.note.at === "number" ? props.note.at : 0;
        return Math.max(0, Math.min(1, 1 - (notesClock() - at) / autoHideTimeoutMs));
      };
      const seconds = () =>
        Math.max(0, Math.ceil((remaining() * autoHideTimeoutMs) / 1000));
      return (
        <Show when={autoHideTimeoutMs > 0}>
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            role="img"
            aria-label={`Note expires in ${seconds()}s`}
            style={{ flex: "0 0 auto", transform: "rotate(-90deg)" }}
          >
            <title>{remaining() > 0 ? `Expires in ${seconds()}s` : "Expiring now"}</title>
            <circle
              cx="8"
              cy="8"
              r={NOTE_RING_RADIUS}
              fill="none"
              stroke="currentColor"
              stroke-opacity="0.2"
              stroke-width="2"
            />
            <circle
              cx="8"
              cy="8"
              r={NOTE_RING_RADIUS}
              fill="none"
              stroke={remaining() < 0.25 ? "#f59e0b" : "currentColor"}
              stroke-width="2"
              stroke-linecap="round"
              stroke-dasharray={`${NOTE_RING_CIRCUMFERENCE}`}
              stroke-dashoffset={`${NOTE_RING_CIRCUMFERENCE * (1 - remaining())}`}
            />
          </svg>
        </Show>
      );
    };

    const NotesMenu = (props: { session: MountedSession; sessionID: string }) => {
      onCleanup(() => setInteracting(false));
      const notes = createMemo(() => notesForSession(props.sessionID));
      const showLine = () => guiSaySurfaces(sayModes, layoutMode()).line;
      const line = () =>
        showLine() ? buildNotesLine(notes(), props.sessionID) : "";

      const markPending = (ids: readonly string[]) =>
        setPendingNoteDismissals((prev) => {
          const next = { ...prev };
          const at = Date.now();
          for (const id of ids) next[id] = at;
          return next;
        });
      const unmarkPending = (ids: readonly string[]) =>
        setPendingNoteDismissals((prev) => {
          const next = { ...prev };
          for (const id of ids) delete next[id];
          return next;
        });

      const dismissNote = (note: GuiNote) => {
        markPending([note.id]);
        void rpcFor(props.session)
          .dismissNote({ noteID: note.id })
          .then((result) => {
            if (result.ok) return;
            unmarkPending([note.id]);
            ctx.toast.show({
              title: "Note already dismissed",
              description: "It was removed by another view.",
              variant: "default",
            });
          })
          .catch((error: unknown) => {
            unmarkPending([note.id]);
            ctx.toast.show({
              title: "Dismiss note failed",
              description: String(error),
              variant: "error",
            });
          });
      };

      const dismissAllNotes = () => {
        const ids = notes().map((note) => note.id);
        if (ids.length === 0) return;
        markPending(ids);
        void rpcFor(props.session)
          .clearNotes({ sessionID: props.sessionID })
          .then((result) => {
            if (result.removed === 0) unmarkPending(ids);
            void refresh();
          })
          .catch((error: unknown) => {
            unmarkPending(ids);
            ctx.toast.show({
              title: "Dismiss all notes failed",
              description: String(error),
              variant: "error",
            });
          });
      };

      return (
        <div
          onPointerEnter={() => setInteracting(true)}
          onPointerLeave={() => setInteracting(false)}
          style={{
            display: "flex",
            "flex-direction": "column",
            gap: "8px",
            "min-width": "320px",
            "max-width": "520px",
          }}
        >
          <Show when={line()}>
            <div
              title={line()}
              style={{
                "font-size": "11px",
                opacity: "0.62",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
              }}
            >
              {line()}
            </div>
          </Show>
          <For each={notes()}>
            {(note) => (
              <div style={{ display: "flex", "flex-direction": "column", gap: "2px" }}>
                <div
                  style={{
                    display: "flex",
                    "justify-content": "space-between",
                    "align-items": "center",
                    gap: "12px",
                    "font-size": "11px",
                    color: "#94a3b8",
                  }}
                >
                  <span>
                    {noteAuthorLabel(note, props.sessionID)} · {note.kind}
                    {note.eta ? ` · ETA ${note.eta}` : ""}
                  </span>
                  <span
                    style={{
                      display: "flex",
                      "align-items": "center",
                      gap: "6px",
                      "flex": "0 0 auto",
                    }}
                  >
                    <NoteExpiryRing note={note} />
                    <span title={new Date(note.at).toLocaleString()}>
                      {formatRelative(note.at)}
                    </span>
                    <button
                      type="button"
                      class="progress-pill-button"
                      title="Dismiss this note"
                      aria-label="Dismiss note"
                      onClick={() => dismissNote(note)}
                      style={{
                        border: "1px solid rgba(127,127,127,0.35)",
                        background: "transparent",
                        color: "inherit",
                        opacity: "0.7",
                        "border-radius": "50%",
                        width: "20px",
                        height: "20px",
                        cursor: "pointer",
                        "line-height": "1",
                        padding: "0",
                      }}
                    >
                      ×
                    </button>
                  </span>
                </div>
                <div
                  style={{
                    "font-size": "13px",
                    "white-space": "pre-wrap",
                    "overflow-wrap": "anywhere",
                  }}
                >
                  {note.text}
                </div>
              </div>
            )}
          </For>
          <Show when={notes().length > 0}>
            <div
              style={{
                display: "flex",
                "padding-top": "2px",
                "border-top": "1px solid rgba(127,127,127,0.2)",
              }}
            >
              <button
                type="button"
                class="progress-pill-button"
                onClick={dismissAllNotes}
                style={footerButtonStyle}
              >
                ✕ Dismiss all notes ({notes().length})
              </button>
            </div>
          </Show>
        </div>
      );
    };

    ctx.add(ComposerPill, () => ({
      id: "progress",
      show: (input) => {
        if (layoutMode() === "sidebar") return undefined;
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

        const visibleRoots = buildVisibleTree(
          scoped,
          Date.now(),
          visibility,
          dismissedMap(scoped)
        );
        if (visibleRoots.length === 0) return undefined;

        const active = countActive(visibleRoots);
        const top = visibleRoots[0];
        const topPct = progressLabel(top.progress);
        const parts = barParts(top.progress, options());
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
          // "4 active · 2 pending · 3 done · 2 dismissed".
          title: (() => {
            const summary = summarizeEntries(scoped);
            const parts: string[] = [];
            if (summary.active > 0) parts.push(`${summary.active} active`);
            if (summary.pending > 0) parts.push(`${summary.pending} pending`);
            if (summary.done > 0) parts.push(`${summary.done} done`);
            if (summary.dismissed > 0) parts.push(`${summary.dismissed} dismissed`);
            return parts.length > 0 ? parts.join(" · ") : "Agent progress";
          })(),
          rows: [
            ...flattenTreeWithDepth(visibleRoots)
              .slice(0, 7)
              .map(({ node, depth }) => {
                const row = rowFor(node, depth, options(), treeTheme());
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
        <ProgressMenu
          session={input.session}
          sessionID={input.session.id}
          close={input.close}
        />
      ),
    }));

    // Optional second pill for `say` notes. Opt in with { options: { say: true } }.
    // Pills float above the timeline, so this stays visible in both composer
    // and sidebar layouts; sidebar mode simply has no notes panel of its own.
    ctx.add(ComposerPill, {
      id: "say-notes",
      order: 1,
      show: (input) => {
        if (!sayNotesEnabled) return undefined;
        if (!saySurfaces().pill) return undefined;
        const view = buildNotesPill(notesForSession(input.session.id));
        if (!view) return undefined;
        return {
          label: view.label,
          title: view.title,
          icon: "speech-bubble" as const,
          ...(view.tone ? { tone: view.tone } : {}),
        };
      },
      menu: (input) => (
        <NotesMenu session={input.session} sessionID={input.session.id} />
      ),
    });

    const toggleTaskListView = async () => {
      try {
        const result = await ctx.client.rpc(ProgressRpc).toggleTaskListMode({});
        setTaskListStatus((prev) => (prev ? { ...prev, mode: result.mode } : prev));
        ctx.toast.show({
          title: "Task-list mirror",
          description: result.mode === "raw" ? "Raw store view" : "Matching the UI",
          variant: "success",
        });
      } catch (error) {
        ctx.toast.show({
          title: "Task-list toggle failed",
          description: String(error),
          variant: "error",
        });
      }
    };

    ctx.add(Command, () => ({
      id: "progress.toggle-tasklist-view",
      title: "Progress: task-list mirror view (match UI/raw)",
      description: "Toggle the Markdown task list between the UI view and the raw store view",
      keywords: "progress tasklist markdown mirror raw ui",
      section: "general",
      get enabled() {
        return taskListStatus()?.enabled === true;
      },
      run: () => void toggleTaskListView(),
    }));

    type NudgePreset = "replace" | "alongside" | "block" | "custom";
    const NUDGE_PRESET_CHOICES: Array<{
      value: NudgePreset;
      title: string;
      description: string;
    }> = [
      {
        value: "replace",
        title: "Replace built-ins (recommended)",
        description: "One [warn] context reminder every 5m; pauses built-in nudges while active.",
      },
      {
        value: "alongside",
        title: "Alongside built-ins",
        description: "Same timing; built-in nudges keep running and identical text is deduped.",
      },
      {
        value: "block",
        title: "Synthetic block",
        description: "One-shot synthetic turn input. Use for hard stop conditions only.",
      },
      {
        value: "custom",
        title: "Custom",
        description: "Choose trigger, severity, delivery, TTL, and fire cap yourself.",
      },
    ];

    const openNudgeWizard = async () => {
      const session = ctx.sessions.current();
      if (!session) return;
      const rpc = rpcFor(session);
      const preset = await ctx.dialogs.select<NudgePreset>({
        title: "Progress custom nudge",
        options: NUDGE_PRESET_CHOICES.map((choice) => ({
          title: choice.title,
          value: choice.value,
          description: choice.description,
        })),
      });
      if (!preset) return;

      const scope = await ctx.dialogs.select<"session" | "project" | "global">({
        title: "Where should this rule live?",
        options: [
          { title: "Session", value: "session", description: "This session only" },
          { title: "Project", value: "project", description: "Every session in this project" },
          { title: "Global", value: "global", description: "Every session, in ~/.config/opencode" },
        ],
        current: "session",
      });
      if (!scope) return;

      const id = (
        await ctx.dialogs.prompt({
          title: "Rule id",
          description: "Slug used by on/off/clear, e.g. stale-build",
          placeholder: "stale-build",
        })
      )?.trim();
      if (!id) return;

      const text = (
        await ctx.dialogs.prompt({
          title: "Reminder text",
          description:
            "Model-facing. Placeholders: {id} {title} {status} {age} {count} {action}",
          placeholder: "{id} has been {status} for {age} — {action}",
        })
      )?.trim();
      if (!text) return;

      let every: string | undefined;
      if (preset === "custom") {
        every =
          (
            await ctx.dialogs.prompt({
              title: "Interval (blank for event-only)",
              description: "5m, 30s, 2h",
              placeholder: "5m",
            })
          )?.trim() || undefined;
      }

      const severity =
        preset === "block"
          ? "block"
          : ((await ctx.dialogs.select<"info" | "warn" | "block">({
              title: "Severity",
              options: [
                { title: "warn (context)", value: "warn" },
                { title: "info (context)", value: "info" },
                { title: "block", value: "block" },
              ],
              current: "warn",
            })) ?? "warn");

      const confirmed = await ctx.dialogs.confirm({
        title: "Save custom nudge?",
        description: `${scope}:${id} · ${severity} · ${preset}\n${
          every ? `every ${every}` : preset === "custom" ? "event-only" : "preset timing"
        }\n${text}`,
      });
      if (!confirmed) return;

      const result = await withTimeout(
        rpc.nudgeSet({
          sessionID: session.id,
          preset,
          rule: {
            id,
            text,
            scope,
            severity,
            source: "user",
            createdAt: Date.now(),
            ...(every
              ? { trigger: { type: "interval", everyMs: every } }
              : preset === "custom"
                ? { trigger: { type: "event" } }
                : {}),
          },
        }),
        4000
      );
      ctx.toast.show({
        title: result.ok ? "Custom nudge saved" : "Custom nudge not saved",
        description: result.ok
          ? `${scope}:${id}`
          : result.error ?? "unknown error",
        variant: result.ok ? "success" : "error",
        duration: result.ok ? 2500 : 6000,
      });
    };

    const openNudgeStatus = async () => {
      const session = ctx.sessions.current();
      if (!session) return;
      const rpc = rpcFor(session);
      let listed: Awaited<ReturnType<typeof rpc.nudgeList>>;
      try {
        listed = await withTimeout(rpc.nudgeList({ sessionID: session.id }), 4000);
      } catch (error) {
        ctx.toast.show({
          title: "Custom nudge status failed",
          description: String(error),
          variant: "error",
        });
        return;
      }
      if (listed.rules.length === 0) {
        await ctx.dialogs.alert({
          title: "Progress custom nudges",
          description: listed.errors.join("\n") || "No rules yet. Use the custom nudge wizard to add one.",
        });
        return;
      }
      const choice = await ctx.dialogs.select<string>({
        title: "Progress custom nudges",
        options: listed.rules.map((rule) => ({
          title: `${rule.enabled ? "on" : "off"} · ${rule.scope}:${rule.id}`,
          value: `${rule.scope}:${rule.id}`,
          description: `${rule.severity} · ${rule.delivery} · ${rule.trigger} · ${rule.criteria}`,
        })),
      });
      if (!choice) return;
      const [scope, id] = choice.split(":", 2) as [
        "global" | "project" | "session",
        string
      ];
      const action = await ctx.dialogs.select<"enable" | "disable" | "clear">({
        title: `Action for ${choice}`,
        options: [
          { title: "Enable", value: "enable" },
          { title: "Disable", value: "disable" },
          { title: "Clear", value: "clear" },
        ],
      });
      if (!action) return;
      const result =
        action === "clear"
          ? await withTimeout(rpc.nudgeClear({ sessionID: session.id, scope, id }), 4000)
          : await withTimeout(
              rpc.nudgeSetEnabled({
                sessionID: session.id,
                scope,
                id,
                enabled: action === "enable",
              }),
              4000
            );
      ctx.toast.show({
        title: result.ok ? `Custom nudge ${action}d` : "Custom nudge unchanged",
        description: result.ok ? choice : result.error ?? "unknown error",
        variant: result.ok ? "success" : "error",
      });
    };

    const progressTab = {
      id: GUI_PROGRESS_PANEL_ID,
      title: "Progress",
      // Not pinned: pinned tabs cannot be dragged. `closable: false` keeps the
      // sidebar-slot behavior (no close button) while allowing reordering.
      closable: false as const,
      fallback: true,
    };

    const NUDGE_PANEL_TAB_ID = "nudges";
    const nudgesTab = {
      id: NUDGE_PANEL_TAB_ID,
      title: "Nudges",
      closable: "compact" as const,
    };

    type NudgeTelemetry = Awaited<ReturnType<ProgressClient["nudgeTelemetry"]>>;

    const nudgeSeverityColor = (severity: unknown) =>
      severity === "block" ? "#f87171" : severity === "warn" ? "#fbbf24" : "#60a5fa";

    const nudgeAge = (ts: unknown) => {
      const at = typeof ts === "string" ? Date.parse(ts) : NaN;
      if (!Number.isFinite(at)) return "";
      const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
      if (seconds < 60) return `${seconds}s`;
      if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
      return `${Math.round(seconds / 3600)}h`;
    };

    /** Agent → plugin signals vs reminders injected toward the agent. */
    const NUDGE_INBOUND = new Set([
      "transition",
      "compliance",
      "nudge-touch",
      "nudge-clear",
      "nudge-reset",
      "nudge-mute",
      "nudge-unmute",
      "subagent",
    ]);
    const NUDGE_OUTBOUND = new Set([
      "nudge",
      "nudge-shadow",
      "reminder",
      "strict",
      "wall-clock",
      "idle-reminder",
      "relay-hint",
      "say-nudge",
      "unhinged",
      "custom-nudge",
    ]);
    const nudgeDirection = (event: Record<string, unknown>) => {
      const name = String(event.event ?? "");
      if (NUDGE_INBOUND.has(name)) return "in";
      if (NUDGE_OUTBOUND.has(name)) return "out";
      return "";
    };

    /** A subagent name when the event came from a child session or entry. */
    const nudgeSubagent = (event: Record<string, unknown>) => {
      if (typeof event.subagent === "string" && event.subagent) return event.subagent;
      const id = typeof event.id === "string" ? event.id : "";
      const stripped = id.includes(":") ? id.slice(id.lastIndexOf(":") + 1) : id;
      return stripped.startsWith("subagent-") ? "subagent" : "";
    };

    const nudgeEventSummary = (event: Record<string, unknown>) => {
      const parts: string[] = [];
      const producer =
        typeof event.producer === "string"
          ? event.producer
          : typeof event.source === "string"
            ? event.source
            : "";
      if (producer) parts.push(producer);
      if (typeof event.id === "string" && event.id) {
        const raw = event.id.includes(":")
          ? event.id.slice(event.id.lastIndexOf(":") + 1)
          : event.id;
        parts.push(raw.length > 28 ? `${raw.slice(0, 27)}…` : raw);
      }
      if (typeof event.to === "string" && event.to) {
        const rawFrom =
          event.transitionFrom !== undefined ? event.transitionFrom : event.from;
        const from = typeof rawFrom === "string" && rawFrom ? rawFrom : "new";
        const count =
          typeof event.transitionCount === "number" && event.transitionCount > 1
            ? ` ×${event.transitionCount}`
            : "";
        parts.push(`${from} → ${event.to}${count}`);
      }
      if (typeof event.action === "string" && event.action) parts.push(event.action);
      if (typeof event.count === "number") parts.push(`#${event.count}`);
      if (typeof event.severity === "string" && event.severity) parts.push(event.severity);
      if (typeof event.delivery === "string" && event.delivery) parts.push(event.delivery);
      if (typeof event.reason === "string" && event.reason) parts.push(event.reason);
      if (typeof event.suppressed === "string") parts.push(`suppressed: ${event.suppressed}`);
      if (event.deduped === true) parts.push("deduped");
      if (typeof event.minutes === "number") parts.push(`${event.minutes}m`);
      if (typeof event.agent === "string" && event.agent) parts.push(event.agent);
      if (typeof event.tool === "string" && event.tool) parts.push(event.tool);
      if (typeof event.description === "string" && event.description) {
        parts.push(
          event.description.length > 80
            ? `${event.description.slice(0, 80)}…`
            : event.description
        );
      }
      return parts.join(" · ");
    };

    const nudgeEventText = (event: Record<string, unknown>) => {
      if (typeof event.text !== "string" || !event.text) return "";
      return event.text.length > 240 ? `${event.text.slice(0, 240)}…` : event.text;
    };

    const NudgePanel = (props: {
      session: () => MountedSession;
      sessionID: () => string;
    }) => {
      const [telemetry, setTelemetry] = createSignal<NudgeTelemetry>();
      const [error, setError] = createSignal("");
      const [delayed, setDelayed] = createSignal(false);
      const [busy, setBusy] = createSignal(false);
      let currentSession = "";
      let refreshing = false;

      const refresh = async () => {
        if (refreshing) return;
        refreshing = true;
        const requested = props.sessionID();
        try {
          const next = await withTimeout(
            rpcFor(props.session()).nudgeTelemetry({
              sessionID: requested,
              limit: 60,
            }),
            8000
          );
          if (requested !== currentSession) return;
          setTelemetry(next);
          setError("");
          setDelayed(false);
        } catch (failure) {
          if (requested !== currentSession) return;
          // A slow RPC is a transient stall, not a broken panel: keep the last
          // snapshot and retry on the next tick instead of painting red.
          if (/timeout/i.test(String(failure))) setDelayed(true);
          else setError(String(failure));
        } finally {
          refreshing = false;
        }
      };

      createEffect(() => {
        const id = props.sessionID();
        if (!id || id === currentSession) return;
        currentSession = id;
        void refresh();
      });

      onMount(() => {
        const timer = setInterval(() => void refresh(), 5000);
        onCleanup(() => clearInterval(timer));
      });

      const mutedMs = () => {
        const until = telemetry()?.mutedUntil ?? 0;
        return until > Date.now() ? until - Date.now() : 0;
      };

      const mutedLabel = () => {
        const ms = mutedMs();
        if (ms <= 0) return "";
        const minutes = Math.ceil(ms / 60_000);
        return minutes >= 60 ? `${Math.ceil(minutes / 60)}h` : `${minutes}m`;
      };

      const shortDuration = (ms: number) => {
        const seconds = Math.max(0, Math.ceil(ms / 1000));
        if (seconds < 60) return `${seconds}s`;
        const minutes = Math.ceil(seconds / 60);
        if (minutes < 60) return `${minutes}m`;
        const hours = Math.floor(minutes / 60);
        const rest = minutes % 60;
        return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
      };

      /** Real gate state from the shared adapter's session record. */
      const sessionState = () => {
        const view = telemetry();
        if (!view) return [];
        if (view.engine === "legacy") {
          return [
            {
              label: "legacy engine",
              color: "#94a3b8",
              title: "Set nudgeEngine: shared to use the shared gate",
            },
          ];
        }
        const now = Date.now();
        const chips: Array<{ label: string; color: string; title: string }> = [];
        if (view.mutedUntil > now) {
          chips.push({
            label: `muted • ${shortDuration(view.mutedUntil - now)} remaining`,
            color: "#fbbf24",
            title: "Non-block reminders are muted; block reminders still fire",
          });
        }
        if (view.standing?.at) {
          chips.push({
            label: `nudged • ${shortDuration(now - view.standing.at)} ago`,
            color: nudgeSeverityColor(view.standing.severity),
            title: `Standing ${view.standing.severity} reminder from ${view.standing.source}`,
          });
        }
        if (view.graceMs > 0 && view.lastProgressAt > 0) {
          const elapsed = now - view.lastProgressAt;
          if (elapsed >= 0 && elapsed < view.graceMs) {
            chips.push({
              label: `grace • ${shortDuration(view.graceMs - elapsed)} left`,
              color: "#34d399",
              title: "Grace after the last progress write; non-block reminders wait",
            });
          }
        }
        if (view.gapMs > 0 && view.lastReminderAt > 0) {
          const elapsed = now - view.lastReminderAt;
          if (elapsed >= 0 && elapsed < view.gapMs) {
            chips.push({
              label: `gap • ${shortDuration(view.gapMs - elapsed)} left`,
              color: "#38bdf8",
              title: "Global gap since the last reminder; non-block reminders wait",
            });
          }
        }
        if (view.capPerSession > 0 && view.fires >= view.capPerSession) {
          chips.push({
            label: `capped • ${view.fires}/${view.capPerSession}`,
            color: "#f87171",
            title: "Per-stretch fire cap reached until the next progress write",
          });
        }
        if (chips.length === 0) {
          chips.push({
            label: "listening",
            color: "#34d399",
            title: "No mute, standing nudge, grace, gap, or cap",
          });
        }
        return chips;
      };

      const toggleMute = async () => {
        if (busy()) return;
        setBusy(true);
        try {
          const result = await withTimeout(
            rpcFor(props.session()).nudgeMute({
              sessionID: props.sessionID(),
              minutes: mutedMs() > 0 ? 0 : 30,
            }),
            8000
          );
          if (!result.ok) {
            ctx.toast.show({
              title: "Nudges are legacy-managed",
              description: "The shared adapter is not attached for this session.",
              variant: "default",
            });
          }
          await refresh();
        } catch (failure) {
          setError(String(failure));
        } finally {
          setBusy(false);
        }
      };

      const purge = async () => {
        if (busy()) return;
        const confirmed = await ctx.dialogs.confirm({
          title: "Purge nudge state?",
          description:
            "Clears this session's mute, standing reminder, gap clock, and fire count. " +
            "The telemetry log is kept. Progress and task state are untouched.",
          confirm: "Purge",
          danger: true,
        });
        if (!confirmed) return;
        setBusy(true);
        try {
          const result = await withTimeout(
            rpcFor(props.session()).nudgePurge({ sessionID: props.sessionID() }),
            8000
          );
          ctx.toast.show({
            title: result.ok ? "Nudge state purged" : "Nudges are legacy-managed",
            description: result.ok
              ? "Mute, standing reminder, gap, and cap reset."
              : "The shared adapter is not attached for this session.",
            variant: result.ok ? "success" : "default",
          });
          await refresh();
        } catch (failure) {
          setError(String(failure));
        } finally {
          setBusy(false);
        }
      };

      const [showTransitions, setShowTransitions] = createSignal(false);
      const events = () => telemetry()?.events ?? [];
      const feedRows = createMemo(() => nudgeFeedRows(events(), showTransitions()));
      const counts = () => telemetry()?.counts ?? {};

      const eventEntryStatus = (event: Record<string, unknown>) => {
        const id = typeof event.id === "string" ? event.id : "";
        const session = typeof event.sessionID === "string" ? event.sessionID : "";
        if (!id || !session) return "";
        return telemetry()?.entryView?.[`${session}:${id}`] ?? "";
      };

      const topCounts = (map: Record<string, number> | undefined) =>
        Object.entries(map ?? {})
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5);

      const shortMs = (ms: number) => {
        if (!Number.isFinite(ms) || ms <= 0) return "—";
        return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
      };

      const health = () => telemetry()?.health;
      const standing = () => telemetry()?.standing;
      const standingActive = () => {
        const value = standing();
        return Boolean(value && value.at > 0 && value.text);
      };

      return (
        <div
          style={{
            height: "100%",
            "overflow-y": "auto",
            "overflow-x": "hidden",
            "box-sizing": "border-box",
          }}
        >
          <div
            style={{
              display: "flex",
              "flex-direction": "column",
              "min-height": "100%",
              "box-sizing": "border-box",
              gap: "6px",
            }}
          >
          <div
            style={{
              display: "flex",
              "align-items": "center",
              gap: "8px",
              "padding-bottom": "6px",
              "border-bottom": "1px solid rgba(127,127,127,0.2)",
              "flex": "0 0 auto",
            }}
          >
            <span style={{ "font-size": "12px", opacity: "0.65" }}>
              {telemetry()?.engine ?? "loading"}
            </span>
            <span
              title={`${telemetry()?.fires ?? 0} adapter fires this process`}
              style={{
                "font-size": "11px",
                opacity: "0.55",
                flex: "1 1 auto",
                "white-space": "nowrap",
                overflow: "hidden",
                "text-overflow": "ellipsis",
              }}
            >
              {telemetry()
                ? `${telemetry()!.fires} fires · ${counts().nudge ?? 0} logged${delayed() ? " · delayed" : ""}`
                : "reading telemetry"}
            </span>
            <button
              type="button"
              class="progress-pill-button"
              disabled={busy() || telemetry()?.engine === "legacy"}
              title={
                telemetry()?.engine === "legacy"
                  ? "Mute is managed by the legacy reminder options"
                  : mutedMs() > 0
                    ? "Resume reminders for this session"
                    : "Mute reminders for this session for 30 minutes"
              }
              onClick={() => void toggleMute()}
              style={sidebarHeaderButtonStyle}
            >
              {mutedMs() > 0 ? `Unmute ${mutedLabel()}` : "Mute 30m"}
            </button>
            <button
              type="button"
              class="progress-pill-button"
              disabled={busy() || telemetry()?.engine === "legacy"}
              title="Clear this session's mute, standing reminder, gap clock, and fire count"
              onClick={() => void purge()}
              style={sidebarHeaderButtonStyle}
            >
              Purge
            </button>
          </div>

          <div
            style={{
              display: "flex",
              "flex-wrap": "wrap",
              gap: "4px",
              "flex": "0 0 auto",
            }}
          >
            <For each={sessionState()}>
              {(chip) => (
                <span
                  title={chip.title}
                  style={{
                    "font-size": "11px",
                    color: chip.color,
                    border: "1px solid currentColor",
                    "border-radius": "4px",
                    padding: "1px 5px",
                    opacity: "0.9",
                    "white-space": "nowrap",
                  }}
                >
                  [{chip.label}]
                </span>
              )}
            </For>
          </div>

          <Show when={health()}>
            <div
              style={{
                display: "flex",
                "flex-direction": "column",
                gap: "2px",
                "font-size": "11px",
                opacity: "0.62",
                "flex": "0 0 auto",
              }}
            >
              <div
                title="Applied reminders by producer in the current log window"
                style={{
                  "white-space": "nowrap",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                }}
              >
                fires{" "}
                {topCounts(health()?.bySource)
                  .map(([key, value]) => `${key} ${value}`)
                  .join(" · ") || "—"}
              </div>
              <div
                title="Suppressed attempts by reason"
                style={{
                  "white-space": "nowrap",
                  overflow: "hidden",
                  "text-overflow": "ellipsis",
                }}
              >
                rejects{" "}
                {topCounts(health()?.rejects)
                  .map(([key, value]) => `${key} ${value}`)
                  .join(" · ") || "—"}
                {health()!.compliance.samples > 0
                  ? ` · compliance ${shortMs(health()!.compliance.medianMs)} median`
                  : ""}
              </div>
            </div>
          </Show>

          <div
            style={{
              display: "flex",
              gap: "4px",
              "flex-wrap": "wrap",
              "flex": "0 0 auto",
            }}
          >
            <button
              type="button"
              class="progress-pill-button"
              aria-pressed={showTransitions()}
              title={
                showTransitions()
                  ? "Hide transition rows"
                  : "Show transition rows (hidden by default)"
              }
              onClick={() => setShowTransitions((value) => !value)}
              style={sidebarHeaderButtonStyle}
            >
              {showTransitions() ? "Hide transitions" : "Show transitions"}
            </button>
          </div>

          <Show when={error()}>
            <div style={{ "font-size": "11px", color: "#f87171" }}>{error()}</div>
          </Show>

          <Show when={standingActive()}>
            <div
              style={{
                display: "flex",
                "flex-direction": "column",
                gap: "3px",
                padding: "6px 8px",
                "border-radius": "6px",
                background: "rgba(127,127,127,0.1)",
                "border-left": `3px solid ${nudgeSeverityColor(standing()?.severity)}`,
                "flex": "0 0 auto",
              }}
            >
              <div style={{ display: "flex", gap: "6px", "font-size": "11px" }}>
                <span style={{ color: nudgeSeverityColor(standing()?.severity), "font-weight": "600" }}>
                  {standing()?.severity || "reminder"}
                </span>
                <span style={{ opacity: "0.55", flex: "1 1 auto" }}>{standing()?.source}</span>
                <span style={{ opacity: "0.4" }}>
                  {standing()?.at ? nudgeAge(new Date(standing()!.at).toISOString()) : ""}
                </span>
              </div>
              <div style={{ "font-size": "12px", "white-space": "pre-wrap" }}>
                {standing()?.text}
              </div>
            </div>
          </Show>

          <div
            style={{
              "font-size": "11px",
              opacity: "0.5",
              "flex": "0 0 auto",
            }}
          >
            {telemetry()?.engine === "legacy"
              ? "Legacy engine · recent reminders"
              : "Shared adapter · recent gate decisions"}
          </div>

          <div
            style={{
              display: "flex",
              "flex-direction": "column",
              "padding-right": "2px",
            }}
          >
            <Show
              when={events().length > 0}
              fallback={
                <div style={{ opacity: "0.6", "font-size": "13px", padding: "8px 2px" }}>
                  No nudge events for this session yet
                </div>
              }
            >
              <For each={feedRows()}>
                {(event) => (
                  <div
                    style={{
                      display: "flex",
                      "flex-direction": "column",
                      gap: "2px",
                      padding: "5px 0",
                      "border-bottom": "1px solid rgba(127,127,127,0.12)",
                    }}
                  >
                    <div style={{ display: "flex", gap: "6px", "font-size": "11px" }}>
                      <Show when={nudgeSubagent(event)}>
                        <span
                          title={`Subagent: ${nudgeSubagent(event)}`}
                          style={{ color: "#c084fc", "font-weight": "700" }}
                        >
                          {nudgeSubagent(event) === "subagent"
                            ? "[sub]"
                            : `[sub ${
                                nudgeSubagent(event).length > 14
                                  ? `${nudgeSubagent(event).slice(0, 13)}…`
                                  : nudgeSubagent(event)
                              }]`}
                        </span>
                      </Show>
                      <Show when={nudgeDirection(event)}>
                        <span
                          title={
                            nudgeDirection(event) === "in"
                              ? "Inbound: an agent wrote progress or used the nudge tool"
                              : "Outbound: a reminder or gate decision aimed at the agent"
                          }
                          style={{
                            color: nudgeDirection(event) === "in" ? "#60a5fa" : "#fbbf24",
                            "font-weight": "700",
                          }}
                        >
                          [{nudgeDirection(event)}]
                        </span>
                      </Show>
                      <Show when={eventEntryStatus(event)}>
                        <span
                          title={
                            eventEntryStatus(event) === "visible"
                              ? "Entry is visible in the current progress tree"
                              : `Entry is hidden from the tree (${eventEntryStatus(event)})`
                          }
                          style={{
                            color:
                              eventEntryStatus(event) === "visible" ? "#34d399" : "#fbbf24",
                            opacity: eventEntryStatus(event) === "visible" ? "0.55" : "0.9",
                            "font-weight": "600",
                          }}
                        >
                          {eventEntryStatus(event) === "visible"
                            ? "[tree]"
                            : `[hidden ${eventEntryStatus(event)}]`}
                        </span>
                      </Show>
                      <span
                        style={{
                          color:
                            typeof event.severity === "string" && event.severity
                              ? nudgeSeverityColor(event.severity)
                              : "inherit",
                          "font-weight": "600",
                        }}
                      >
                        {String(event.event ?? "event")}
                      </span>
                      <span
                        title={
                          typeof event.id === "string" && event.id
                            ? `${event.id}\n${nudgeEventSummary(event)}`
                            : nudgeEventSummary(event)
                        }
                        style={{
                          flex: "1 1 auto",
                          opacity: "0.6",
                          "white-space": "nowrap",
                          overflow: "hidden",
                          "text-overflow": "ellipsis",
                        }}
                      >
                        {nudgeEventSummary(event)}
                      </span>
                      <span style={{ opacity: "0.4" }}>{nudgeAge(event.ts)}</span>
                    </div>
                    <Show when={nudgeEventText(event)}>
                      <div
                        title={nudgeEventText(event)}
                        style={{
                          "font-size": "11px",
                          opacity: "0.78",
                          "white-space": "pre-wrap",
                        }}
                      >
                        {nudgeEventText(event)}
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </Show>
          </div>
          </div>
        </div>
      );
    };

    // The side-region tabs: Progress is listed first in sidebar mode and has
    // no close button, but is draggable so it can be reordered. The Nudges tab
    // is always listed so the launcher can open it from the New tab page in
    // either layout mode.
    ctx.add(Panel, {
      id: GUI_PROGRESS_PANEL_ID,
      region: "side",
      width: sidebarWidth,
      mobile: {
        title: "Progress",
        order: 20,
        kind: "menu",
        icon: "checklist",
      },
      list: () => [...(layoutMode() === "sidebar" ? [progressTab] : []), nudgesTab],
      render: (input) =>
        input.tab.id === NUDGE_PANEL_TAB_ID ? (
          <NudgePanel session={() => input.session} sessionID={() => input.session.id} />
        ) : (
          <ProgressSidebar
            session={() => input.session}
            sessionID={() => input.session.id}
          />
        ),
    });

    ctx.add(Command, () => ({
      id: "progress.swap-layout",
      title: "Progress: swap layout (composer/sidebar)",
      description: "Move the progress tree above the prompt or into the sidebar",
      group: "Progress",
      section: "session" as const,
      keywords: "progress sidebar composer layout move",
      run: () => swapLayout(),
    }));

    if (ctx.options?.customNudges === true) {
      ctx.add(Command, () => ({
        id: "progress.custom-nudge",
        title: "Progress: custom nudge…",
        description: "Create a configurable reminder rule for this or every session",
        group: "Progress",
        section: "session" as const,
        keywords: "progress nudge custom reminder rule interval",
        run: () => void openNudgeWizard(),
      }));

      ctx.add(Command, () => ({
        id: "progress.custom-nudge-status",
        title: "Progress: custom nudge status",
        description: "List custom nudge rules; enable, disable, or clear one",
        group: "Progress",
        section: "session" as const,
        keywords: "progress nudge custom list status disable clear",
        run: () => void openNudgeStatus(),
      }));
    }

    ctx.add(Command, () => ({
      id: "progress.indicator-style",
      title: "Progress: indicator style",
      description: "Swap status indicators: flat dots, emoji circles, or checkbox emoji",
      group: "Progress",
      section: "general" as const,
      keywords: "progress indicator status dots emoji circles checkbox",
      run: () => void chooseIndicatorStyle(),
    }));

    ctx.add(Command, () => ({
      id: "progress.switch-tree-theme",
      title: "Progress: switch tree theme",
      description: "Pick the tree row theme; saved to your OpenCode config",
      group: "Progress",
      section: "general" as const,
      keywords: "progress tree theme compact default rows appearance",
      run: () => void switchTreeTheme(),
    }));

    // Launcher for the desktop sidebar's New tab page and + menu, alongside
    // Review / Browser / Terminal / Open file. `opened` follows this tab's own
    // state so the launcher stays listed while some other side tab is open.
    ctx.add(MenuItem, {
      menu: "session.panel",
      // Keep this id distinct from the Panel id. The launcher is a separate
      // registry entry, and an explicit `opened: false` keeps it in the New
      // tab page even while the Progress tab itself is open.
      id: "progress-launcher",
      title: "Progress",
      icon: "checklist",
      order: 20,
      description: "Task tree and notes",
      opened: false,
      run: () => {
        const current = ctx.sessions.current();
        if (!current) return;
        if (layoutMode() !== "sidebar") {
          swapLayout();
          return;
        }
        ctx.layout.open(sidebarPanelKey, current, {
          tab: "select",
          background: true,
        });
      },
    });

    // Sidebar launcher for the Nudges tab. Listed on the New tab page beside
    // Progress / Review / Browser, and opens the shared panel on that tab.
    ctx.add(MenuItem, {
      menu: "session.panel",
      id: "nudge-telemetry-launcher",
      title: "Nudges",
      icon: "notifications",
      order: 21,
      description: "Nudge fires, gate decisions, and mute state",
      opened: false,
      run: () => {
        const current = ctx.sessions.current();
        if (!current) return;
        ctx.layout.open(`${ctx.id}:${NUDGE_PANEL_TAB_ID}`, current, { tab: "select" });
      },
    });

    return () => {
      alive = false;
      clearInterval(timer);
      if (notesClockTimer) clearInterval(notesClockTimer);
      unsubscribeUpdated?.();
      clearInterval(taskListTimer);
    };
  },
});
