/**
 * OpenCode Progress Plugin — TUI part.
 *
 * Reads the shared state file directly (the TUI runs locally) and renders:
 *   - a compact one-line summary in the composer footer,
 *   - a bounded progress tree above the composer.
 *
 * The tree shows one row per root, collapsed by default, and clips to a row
 * budget so a long list can never push the prompt off screen. `/progress`
 * (or the command palette) opens a dialog to expand a tree or dismiss roots;
 * dismissals use the same persisted semantics as the desktop pill.
 */

import { For, Show, createSignal } from "solid-js";
import { Plugin, usePlugin } from "@opencode/plugin/tui";

/** Setup context; the package does not re-export the Context type. */
type TuiContext = Parameters<Parameters<typeof Plugin.define>[0]["setup"]>[0];
import { readProgressState, writeDismissal } from "./state.js";
import {
  buildTree,
  barParts,
  countActive,
  countDescendants,
  dismissedMap,
  isDismissed,
  normalizeBarOptions,
  normalizeRefreshMs,
  normalizeVisibilityOptions,
  oneLineText,
  progressLabel,
  scopeEntries,
  subagentPrefix,
  visibleEntries,
  type BarOptions,
  type VisibilityOptions,
} from "./tree.js";
import { buildTuiView, type TuiRow } from "./tui-view.js";
import type { ProgressStatus, ProgressState, TreeNode } from "./types.js";

const [state, setState] = createSignal<ProgressState>(readProgressState());
/** Root keys expanded per session; replaced wholesale so Solid sees the change. */
const [expandedBySession, setExpandedBySession] = createSignal<
  Record<string, Set<string>>
>({});

let pollers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let barOptions: BarOptions = {};
let visibilityOptions: VisibilityOptions = {};
let maxRows = 8;
let expandRootsByDefault = false;

function startPolling(refreshMs: number): () => void {
  pollers += 1;
  setState(readProgressState());
  if (!timer) {
    timer = setInterval(() => setState(readProgressState()), refreshMs);
  }
  return () => {
    pollers -= 1;
    if (pollers <= 0) {
      if (timer) clearInterval(timer);
      timer = undefined;
      pollers = 0;
    }
  };
}

function glyph(status: ProgressStatus): string {
  if (status === "done") return "✓";
  if (status === "error") return "✗";
  if (status === "waiting") return "◐";
  return "●";
}

function expandedFor(sessionID: string): ReadonlySet<string> {
  return expandedBySession()[sessionID] ?? new Set<string>();
}

function toggleExpanded(sessionID: string, key: string): void {
  setExpandedBySession((prev) => {
    const next = { ...prev };
    const set = new Set(prev[sessionID] ?? []);
    if (set.has(key)) set.delete(key);
    else set.add(key);
    next[sessionID] = set;
    return next;
  });
}

/** Undismissed roots for a session, built from the latest polled state. */
function rootsForSession(sessionID: string): TreeNode[] {
  const entries = state().entries ?? {};
  return buildTree(
    visibleEntries(
      scopeEntries(entries, sessionID, visibilityOptions),
      Date.now(),
      visibilityOptions
    )
  ).filter((root) => !isDismissed(root, dismissedMap(entries)));
}

function ProgressRow(props: { row: TuiRow }) {
  const ctx = usePlugin();
  const indent = () => (props.row.depth === 0 ? "" : "└─ ");
  const detailIndent = () => (props.row.depth === 0 ? "  · " : "    · ");

  const title = () =>
    `${props.row.depth === 0 ? subagentPrefix(props.row.node) : ""}${props.row.node.title}`;

  const marker = () => {
    if (props.row.depth !== 0) return "";
    if (props.row.collapsed) return "▸ ";
    return (props.row.node.children?.length ?? 0) > 0 ? "▾ " : "";
  };

  const suffix = () =>
    props.row.hiddenChildren > 0 ? `  +${props.row.hiddenChildren}` : "";

  const label = () => {
    const parts = barParts(props.row.node.progress, barOptions);
    if (parts.style === "emoji") {
      const done =
        props.row.node.status === "done"
          ? " ✓"
          : props.row.node.status === "error"
          ? " ✗"
          : "";
      return `${marker()}${title()}: ${parts.bar}${parts.fraction}${done}${suffix()}`;
    }
    const pct = progressLabel(props.row.node.progress);
    return `${glyph(props.row.node.status)} [${parts.bar}] ${marker()}${title()}${
      pct ? ` ${pct}` : ""
    }${suffix()}`;
  };

  return (
    <box flexDirection="column" paddingLeft={props.row.depth === 0 ? 0 : 2}>
      <text fg={ctx.theme.text.base} wrapMode="word">
        <span fg={ctx.theme.text.muted}>{indent()}</span>
        {label()}
      </text>
      <Show when={props.row.node.detail}>
        <text fg={ctx.theme.text.muted} wrapMode="word">
          {`${detailIndent()}${oneLineText(props.row.node.detail ?? "").slice(0, 120)}`}
        </text>
      </Show>
    </box>
  );
}

function ProgressTree(props: { sessionID: string }) {
  const ctx = usePlugin();
  const view = () =>
    buildTuiView(rootsForSession(props.sessionID), {
      maxRows,
      expanded: expandedFor(props.sessionID),
      expandByDefault: expandRootsByDefault,
    });

  return (
    <Show when={view().rows.length > 0}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <text fg={ctx.theme.text.muted}>progress</text>
        <For each={view().rows}>{(row) => <ProgressRow row={row} />}</For>
        <Show when={view().hidden > 0}>
          <text fg={ctx.theme.text.muted}>
            {`… +${view().hidden} more · /progress`}
          </text>
        </Show>
      </box>
    </Show>
  );
}

type ProgressChoice =
  | { kind: "done" }
  | { kind: "all" }
  | { kind: "pick-dismiss" }
  | { kind: "toggle"; key: string }
  | { kind: "dismiss"; key: string };

function currentSessionID(context: TuiContext): string | undefined {
  const route = context.ui.router.current();
  return route.type === "session" ? route.sessionID : undefined;
}

function dismissRoots(context: TuiContext, roots: TreeNode[]): void {
  let count = 0;
  for (const root of roots) {
    if (writeDismissal(root.key, root.status ?? "")) count += 1;
  }
  context.ui.toast.show({
    message:
      count === 0
        ? "Nothing to dismiss"
        : `Dismissed ${count} progress task${count === 1 ? "" : "s"}`,
    variant: count === 0 ? "info" : "success",
  });
}

async function openProgressDialog(context: TuiContext): Promise<void> {
  const sessionID = currentSessionID(context);
  if (!sessionID) {
    context.ui.toast.show({ message: "Open a session to manage progress", variant: "warning" });
    return;
  }
  const roots = rootsForSession(sessionID);
  if (roots.length === 0) {
    context.ui.toast.show({ message: "No progress to show", variant: "info" });
    return;
  }

  const done = roots.filter((root) => root.status === "done");
  const expanded = expandedFor(sessionID);
  const choice = await context.ui.dialog.select<ProgressChoice>({
    title: "Progress",
    placeholder: "Filter tasks…",
    options: [
      ...(done.length > 0
        ? [{ title: `Dismiss done (${done.length})`, value: { kind: "done" as const } }]
        : []),
      { title: `Dismiss all (${roots.length})`, value: { kind: "all" as const } },
      { title: "Dismiss a task…", value: { kind: "pick-dismiss" as const } },
      ...roots.map((root) => ({
        title: `${expanded.has(root.key) ? "▾" : "▸"} ${glyph(root.status)} ${root.title}`,
        value: { kind: "toggle" as const, key: root.key },
        description: `${root.status}${
          countDescendants(root) > 0 ? ` · ${countDescendants(root)} descendant(s)` : ""
        }`,
      })),
    ],
    search: (query, options) => {
      const needle = query.trim().toLowerCase();
      if (!needle) return options;
      return options.filter(
        (option) =>
          option.title.toLowerCase().includes(needle) ||
          (option.description ?? "").toLowerCase().includes(needle)
      );
    },
  });

  if (!choice) return;
  if (choice.kind === "done") {
    dismissRoots(context, done);
    return;
  }
  if (choice.kind === "all") {
    const confirmed = await context.ui.dialog.confirm({
      title: "Dismiss all progress?",
      message: `${roots.length} task${roots.length === 1 ? "" : "s"} will be hidden. Agent updates bring them back.`,
      label: { confirm: "Dismiss all" },
    });
    if (confirmed) dismissRoots(context, roots);
    return;
  }
  if (choice.kind === "pick-dismiss") {
    const picked = await context.ui.dialog.select<TreeNode>({
      title: "Dismiss a task",
      placeholder: "Filter tasks…",
      options: roots.map((root) => ({
        title: `${glyph(root.status)} ${root.title}`,
        value: root,
        description: root.status,
      })),
    });
    if (picked) dismissRoots(context, [picked]);
    return;
  }
  if (choice.kind === "toggle") {
    toggleExpanded(sessionID, choice.key);
    return;
  }
  if (choice.kind === "dismiss") {
    const root = roots.find((candidate) => candidate.key === choice.key);
    if (root) dismissRoots(context, [root]);
  }
}

function FooterStatus() {
  const ctx = usePlugin();
  const summary = () => {
    const roots = buildTree(state().entries ?? {});
    const active = countActive(roots);
    return active > 0 ? `${active} active task${active === 1 ? "" : "s"}` : "";
  };

  return (
    <Show when={summary()}>
      <text fg={ctx.theme.text.muted}>{summary()}</text>
    </Show>
  );
}

export default Plugin.define({
  id: "opencode-progress.tui",
  setup(context) {
    barOptions = normalizeBarOptions(context.options);
    visibilityOptions = normalizeVisibilityOptions(context.options);
    expandRootsByDefault = context.options?.expandRootsByDefault === true;
    const configuredRows = context.options?.tuiMaxRows;
    maxRows =
      typeof configuredRows === "number" && configuredRows >= 1
        ? Math.min(50, Math.floor(configuredRows))
        : 8;

    const stopPolling = startPolling(normalizeRefreshMs(context.options));
    if (context.options?.notifyOnLoad === true) {
      context.ui.toast.show({ message: "Progress plugin loaded", variant: "success" });
    }

    context.keymap.layer(() => ({
      commands: [
        {
          id: "progress.open",
          title: "Progress: expand or dismiss",
          description: "Browse progress roots; expand a tree or dismiss tasks",
          group: "progress",
          bind: false,
          palette: true,
          slash: { name: "progress" },
          run: () => openProgressDialog(context),
        },
      ],
    }));

    const unregisterTree = context.ui.slot({
      append: "session.composer.top",
      render: ({ sessionID }) => <ProgressTree sessionID={sessionID} />,
    });
    const unregisterFooter = context.ui.slot({
      append: "home.footer.status",
      render: () => <FooterStatus />,
    });

    return () => {
      unregisterTree?.();
      unregisterFooter?.();
      stopPolling();
    };
  },
});
