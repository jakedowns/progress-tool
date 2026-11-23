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
import {
  clearSayNotes,
  dismissSayNote,
  readProgressState,
  sayNotesForSession,
  writeDismissal,
  softClearSession,
  hardDeleteSession,
  hardDeleteAll,
} from "./state.js";
import {
  readTaskListStatus,
  toggleTaskListMode as toggleTaskListModePref,
  type TaskListStatus,
} from "./tasklist-prefs.js";
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
import {
  buildNoteToast,
  buildNotesLine,
  buildTuiView,
  formatNotesDialog,
  latestSayNote,
  nextTuiLayout,
  normalizeMaxRoots,
  normalizeSidebarRows,
  normalizeTuiLayout,
  noteAuthorPrefix,
  rootDetailLines,
  summarizeRoots,
  type TuiRow,
} from "./tui-view.js";
import { normalizeSayOptions, tuiSaySurfaces } from "./say.js";
import type { ProgressEntry, ProgressStatus, ProgressState, SayNote, TreeNode } from "./types.js";

const [state, setState] = createSignal<ProgressState>(readProgressState());
/** Mirror status is written by the MCP server next to the state file. */
const [taskListStatus, setTaskListStatus] = createSignal<TaskListStatus | null>(
  readTaskListStatus()
);
/** Root keys expanded per session; replaced wholesale so Solid sees the change. */
const [expandedBySession, setExpandedBySession] = createSignal<
  Record<string, Set<string>>
>({});

let pollers = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let barOptions: BarOptions = {};
let visibilityOptions: VisibilityOptions = {};
let maxRows = 8;
let sidebarRows = 0;
let expandRootsByDefault = false;
/** Runtime root cap; seeded from `tuiMaxRoots` and adjustable from the palette. */
let rootCapState: { value: number } = { value: 3 };
let setRootCap: ((mutation: (draft: { value: number }) => void) => void) | undefined;
/** Runtime placement; seeded from `tuiLayout` and flipped by the swap command. */
let layoutState: { mode: "composer" | "sidebar" } = { mode: "composer" };
let setLayout: ((mutation: (draft: { mode: "composer" | "sidebar" }) => void) => void) | undefined;
/** Runtime collapsed view; the palette toggles it between the tree and one summary row. */
let collapsedState: { value: boolean } = { value: false };
let setCollapsed: ((mutation: (draft: { value: boolean }) => void) => void) | undefined;
/** `sayModes` projection for the TUI (pill folds into the tree line). */
let sayLineEnabled = true;
/** Called after every poll with the fresh state so new notes can toast. */
let sayToastHook: ((next: ProgressState) => void) | undefined;

function refreshState(): ProgressState {
  const next = readProgressState();
  setState(next);
  sayToastHook?.(next);
  return next;
}

function startPolling(refreshMs: number): () => void {
  pollers += 1;
  refreshState();
  setTaskListStatus(readTaskListStatus());
  if (!timer) {
    timer = setInterval(() => {
      refreshState();
      setTaskListStatus(readTaskListStatus());
    }, refreshMs);
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
  if (status === "pending") return "○";
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

/** All roots for a session, including dismissed ones, from the latest polled state. */
function allRootsForSession(sessionID: string): TreeNode[] {
  const entries = state().entries ?? {};
  return buildTree(
    visibleEntries(
      scopeEntries(entries, sessionID, visibilityOptions),
      Date.now(),
      visibilityOptions
    )
  );
}

/** Undismissed roots for a session, built from the latest polled state. */
function rootsForSession(sessionID: string): TreeNode[] {
  const entries = state().entries ?? {};
  return allRootsForSession(sessionID).filter(
    (root) => !isDismissed(root, dismissedMap(entries))
  );
}

const STATUS_SUMMARY_ORDER: ProgressStatus[] = ["error", "running", "waiting", "pending", "done"];

/** "1 error / 2 running / 2 waiting / 2 pending / 3 done" across every root, including hidden ones. */
function statusSummary(roots: readonly TreeNode[]): string {
  const counts: Record<ProgressStatus, number> = { pending: 0, error: 0, running: 0, waiting: 0, done: 0 };
  for (const root of roots) {
    if (root.status && root.status in counts) counts[root.status] += 1;
  }
  return STATUS_SUMMARY_ORDER.filter((status) => counts[status] > 0)
    .map((status) => `${counts[status]} ${status}`)
    .join(" / ");
}

type TuiMouseEvent = { button?: number; stopPropagation(): void };

/** Treat a bare mouse event (no button reported) as a left click. */
function leftClick(event: TuiMouseEvent): boolean {
  return event.button === undefined || event.button === 0;
}

function ProgressRow(props: { row: TuiRow; sessionID: string }) {
  const ctx = usePlugin();
  const indent = () => (props.row.depth === 0 ? "" : "└─ ");
  const detailIndent = () => (props.row.depth === 0 ? "  · " : "    · ");

  const isRoot = () => props.row.depth === 0;
  const hasChildren = () => (props.row.node.children?.length ?? 0) > 0;
  const hasMarker = () => isRoot() && hasChildren();

  /** The leading marker is the click-to-expand target; the rest of the row opens the detail. */
  const onToggle = (event: TuiMouseEvent) => {
    if (!leftClick(event) || !hasMarker()) return;
    toggleExpanded(props.sessionID, props.row.node.key);
  };

  /** The row (and its truncated detail line) opens the full description. */
  const onDetail = (event: TuiMouseEvent) => {
    if (!leftClick(event)) return;
    showRootDetail(ctx, props.row.node);
  };

  /** The trailing ✕ is the click-to-dismiss redundancy for `Dismiss a task…`. */
  const onDismiss = (event: TuiMouseEvent) => {
    if (!leftClick(event)) return;
    event.stopPropagation();
    dismissRoots(ctx, [props.row.node]);
  };

  const title = () =>
    `${props.row.depth === 0 ? subagentPrefix(props.row.node) : ""}${props.row.node.title}`;

  const marker = () => (props.row.collapsed ? "▸ " : "▾ ");

  const suffix = () =>
    props.row.hiddenChildren > 0 ? `  +${props.row.hiddenChildren}` : "";

  const detailPreview = () => {
    const full = oneLineText(props.row.node.detail ?? "");
    return full.length > 120 ? `${full.slice(0, 120)}…` : full;
  };

  const label = () => {
    const parts = barParts(props.row.node.progress, barOptions);
    if (parts.style === "emoji") {
      const done =
        props.row.node.status === "done"
          ? " ✓"
          : props.row.node.status === "error"
          ? " ✗"
          : "";
      return `${title()}: ${parts.bar}${parts.fraction}${done}${suffix()}`;
    }
    const pct = progressLabel(props.row.node.progress);
    return `${glyph(props.row.node.status)} [${parts.bar}] ${title()}${
      pct ? ` ${pct}` : ""
    }${suffix()}`;
  };

  return (
    <box flexDirection="column" paddingLeft={props.row.depth === 0 ? 0 : 2}>
      <box flexDirection="row" alignItems="flex-start">
        <Show when={hasMarker()}>
          <text selectable={false} fg={ctx.theme.text.muted} onMouseUp={onToggle}>
            {marker()}
          </text>
        </Show>
        <text
          selectable={false}
          fg={ctx.theme.text.base}
          wrapMode="word"
          flexGrow={1}
          flexShrink={1}
          onMouseUp={onDetail}
        >
          <span fg={ctx.theme.text.muted}>{indent()}</span>
          {label()}
        </text>
        <Show when={isRoot()}>
          <text selectable={false} fg={ctx.theme.text.muted} onMouseUp={onDismiss}>
            {"  ✕"}
          </text>
        </Show>
      </box>
      <Show when={props.row.node.detail}>
        <text
          selectable={false}
          fg={ctx.theme.text.muted}
          wrapMode="word"
          onMouseUp={onDetail}
        >
          {`${detailIndent()}${detailPreview()}`}
        </text>
      </Show>
    </box>
  );
}

function ProgressTree(props: { sessionID: string; capacity?: number; variant?: "composer" | "sidebar" }) {
  const ctx = usePlugin();
  const capacity = props.capacity ?? maxRows;
  const stackedHeader = props.variant === "sidebar";
  const roots = () => rootsForSession(props.sessionID);
  const doneRoots = () => roots().filter((root) => root.status === "done");
  const notes = () => sayNotesForSession(state(), props.sessionID);
  const notesLine = () => buildNotesLine(notes(), props.sessionID);
  const latestNote = () => latestSayNote(notes());
  const showNotesLine = () => sayLineEnabled && notesLine().length > 0;

  /** The trailing ✕ on the notes line dismisses just the latest note. */
  const onDismissNote = (event: TuiMouseEvent) => {
    if (!leftClick(event)) return;
    event.stopPropagation();
    const note = latestNote();
    if (!note) return;
    if (dismissSayNote(note.id)) {
      setState(readProgressState());
      ctx.ui.toast.show({ message: "Note dismissed", variant: "success" });
    } else {
      ctx.ui.toast.show({ message: "Note already dismissed", variant: "info" });
    }
  };
  const view = () =>
    buildTuiView(roots(), {
      maxRows,
      maxRoots: rootCapState.value,
      clipRows: false,
      expanded: expandedFor(props.sessionID),
      expandByDefault: expandRootsByDefault,
    });

  /** Visible terminal lines: one per row plus one for each rendered detail. */
  const lineCount = (rows: readonly TuiRow[]) =>
    rows.reduce((total, row) => total + 1 + (row.node.detail ? 1 : 0), 0);

  const viewportHeight = () => Math.max(1, Math.min(capacity, lineCount(view().rows)));
  const overflowLines = () => Math.max(0, lineCount(view().rows) - capacity);

  const onDismissDone = (event: TuiMouseEvent) => {
    if (!leftClick(event)) return;
    event.stopPropagation();
    dismissRoots(ctx, doneRoots());
  };

  const onDismissAll = (event: TuiMouseEvent) => {
    if (!leftClick(event)) return;
    event.stopPropagation();
    void confirmDismissAll(ctx, roots());
  };

  const title = () => (
    <text
      selectable={false}
      fg={ctx.theme.text.muted}
      onMouseUp={() => openProgressDialog(ctx)}
    >
      progress
    </text>
  );

  const actions = () => (
    <box flexDirection="row">
      <Show when={doneRoots().length > 0}>
        <text selectable={false} fg={ctx.theme.text.base} onMouseUp={onDismissDone}>
          {`dismiss done (${doneRoots().length})`}
        </text>
        <text fg={ctx.theme.text.muted}>{"  ·  "}</text>
      </Show>
      <text selectable={false} fg={ctx.theme.text.base} onMouseUp={onDismissAll}>
        {`dismiss all (${roots().length})`}
      </text>
    </box>
  );

  const collapsed = () => collapsedState.value === true;
  const summary = () => {
    const entries = state().entries ?? {};
    return summarizeRoots(allRootsForSession(props.sessionID), (root) =>
      isDismissed(root, dismissedMap(entries))
    );
  };
  const hasContent = () =>
    showNotesLine() ||
    (collapsed() ? summary().length > 0 : view().rows.length > 0);

  return (
    <Show when={hasContent()}>
      <box flexDirection="column" paddingLeft={1} paddingRight={1} paddingTop={1}>
        <Show when={showNotesLine()}>
          <box flexDirection="row" alignItems="flex-start">
            <text
              selectable={false}
              fg={ctx.theme.text.muted}
              wrapMode="word"
              flexGrow={1}
              flexShrink={1}
              onMouseUp={() => openNotesDialog(ctx, props.sessionID)}
            >
              {notesLine()}
            </text>
            <text
              selectable={false}
              fg={ctx.theme.text.muted}
              onMouseUp={onDismissNote}
            >
              {"  ✕"}
            </text>
          </box>
        </Show>
        <Show when={collapsed()}>
          <text
            selectable={false}
            fg={ctx.theme.text.base}
            onMouseUp={() =>
              setCollapsed?.((draft) => {
                draft.value = false;
              })
            }
          >
            <span fg={ctx.theme.text.muted}>progress: </span>
            {summary()}
          </text>
        </Show>
        <Show when={!collapsed()}>
          <Show
          when={stackedHeader}
          fallback={
            <box flexDirection="row" justifyContent="space-between">
              {title()}
              {actions()}
            </box>
          }
        >
          {title()}
          {actions()}
        </Show>
        <Show
          when={capacity > 0}
          fallback={
            <For each={view().rows}>
              {(row) => <ProgressRow row={row} sessionID={props.sessionID} />}
            </For>
          }
        >
          <scrollbox
            height={viewportHeight()}
            scrollY
            stickyStart="top"
            focusable={false}
          >
            <For each={view().rows}>
              {(row) => <ProgressRow row={row} sessionID={props.sessionID} />}
            </For>
          </scrollbox>
        </Show>
        <Show when={capacity > 0 && overflowLines() > 0}>
          <text selectable={false} fg={ctx.theme.text.muted}>
            {`--- scroll to see ${overflowLines()} more ---`}
          </text>
        </Show>
        <Show when={view().hiddenRoots > 0}>
          <text
            selectable={false}
            fg={ctx.theme.text.base}
            onMouseUp={() => openProgressDialog(ctx)}
          >
            {`view full progress tree (${statusSummary(roots())})`}
          </text>
        </Show>
        </Show>
      </box>
    </Show>
  );
}

type ProgressChoice =
  | { kind: "done" }
  | { kind: "all" }
  | { kind: "pick-dismiss" }
  | { kind: "notes" }
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

/** Click target: the row shows the full, untruncated description in a dialog. */
function showRootDetail(context: TuiContext, root: TreeNode): void {
  void context.ui.dialog.alert({
    title: `${subagentPrefix(root)}${root.title}`,
    message: rootDetailLines(root).join("\n"),
  });
}

/** Flip the tree between above-prompt and sidebar placements. */
function swapLayout(context: TuiContext): void {
  if (!setLayout) return;
  const next = nextTuiLayout(layoutState.mode);
  setLayout((draft) => {
    draft.mode = next;
  });
  context.ui.toast.show({
    message:
      next === "sidebar"
        ? "Progress moved to the sidebar"
        : "Progress moved above the prompt",
    variant: "info",
  });
}

/** Collapse the tree to a one-line summary, or restore it. */
function toggleCollapsed(context: TuiContext): void {
  if (!setCollapsed) return;
  const next = !collapsedState.value;
  setCollapsed((draft) => {
    draft.value = next;
  });
  context.ui.toast.show({
    message: next ? "Progress collapsed to summary" : "Progress tree expanded",
    variant: "info",
  });
}

/** Palette command: choose how many root rows the TUI renders. */
async function promptRootCap(context: TuiContext): Promise<void> {
  const current = rootCapState.value;
  const choice = await context.ui.dialog.select<number>({
    title: "Progress root cap",
    current,
    options: [1, 2, 3, 5, 10, 25].map((value) => ({
      title: `${value} root${value === 1 ? "" : "s"}`,
      value,
      description: value === current ? "current" : undefined,
    })),
  });
  if (choice == null) return;
  setRootCap?.((draft) => {
    draft.value = choice;
  });
  context.ui.toast.show({
    message: `Showing up to ${choice} root${choice === 1 ? "" : "s"}`,
    variant: "info",
  });
}

function sessionEntriesOf(sessionID: string): Array<[string, ProgressEntry]> {
  return Object.entries(state().entries ?? {}).filter(
    ([key, entry]) =>
      entry &&
      typeof entry === "object" &&
      (entry.sessionId === sessionID || key.startsWith(`${sessionID}:`))
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/** Palette-only: soft-clear finished and dismissed entries for this session. */
async function clearList(context: TuiContext): Promise<void> {
  const sessionID = currentSessionID(context);
  if (!sessionID) {
    context.ui.toast.show({ message: "Open a session to manage progress", variant: "warning" });
    return;
  }
  const candidates = sessionEntriesOf(sessionID).filter(
    ([, entry]) =>
      !entry.cleared &&
      (entry.status === "done" || entry.status === "error" || Boolean(entry.dismissed))
  );
  if (candidates.length === 0) {
    context.ui.toast.show({ message: "Nothing to clear", variant: "info" });
    return;
  }
  const confirmed = await context.ui.dialog.confirm({
    title: "Clear progress list?",
    message: `${candidates.length} finished or dismissed ${
      candidates.length === 1 ? "entry" : "entries"
    } will be hidden. Records stay on disk; running tasks keep showing.`,
    label: { confirm: "Clear list" },
  });
  if (!confirmed) return;
  const result = softClearSession(sessionID);
  setState(readProgressState());
  context.ui.toast.show({
    message: `Cleared ${result.cleared} ${result.cleared === 1 ? "entry" : "entries"} (records kept)`,
    variant: "success",
  });
}

/** Palette-only: permanently delete this session's progress entries. */
async function hardClearSessionCommand(context: TuiContext): Promise<void> {
  const sessionID = currentSessionID(context);
  if (!sessionID) {
    context.ui.toast.show({ message: "Open a session to manage progress", variant: "warning" });
    return;
  }
  const entries = sessionEntriesOf(sessionID);
  if (entries.length === 0) {
    context.ui.toast.show({ message: "Nothing to delete", variant: "info" });
    return;
  }
  const bytes = Buffer.byteLength(JSON.stringify(Object.fromEntries(entries)));
  const confirmed = await context.ui.dialog.confirm({
    title: "Permanently delete session progress?",
    message: `${entries.length} ${
      entries.length === 1 ? "entry" : "entries"
    } (${formatBytes(bytes)}) will be removed from the progress store. The mirrored tasklist file is kept. This cannot be undone.`,
    label: { confirm: "Delete permanently" },
  });
  if (!confirmed) return;
  const result = hardDeleteSession(sessionID);
  setState(readProgressState());
  context.ui.toast.show({
    message: `Deleted ${result.removed} ${
      result.removed === 1 ? "entry" : "entries"
    } · ${formatBytes(result.freedBytes)} freed`,
    variant: "success",
  });
}

/** Palette-only: wipe every entry. Requires typing DELETE. */
async function hardClearStoreCommand(context: TuiContext): Promise<void> {
  const entries = Object.values(state().entries ?? {});
  if (entries.length === 0) {
    context.ui.toast.show({ message: "Progress store is already empty", variant: "info" });
    return;
  }
  const bytes = Buffer.byteLength(JSON.stringify(state().entries ?? {}));
  const typed = await context.ui.dialog.prompt({
    title: "Hard clear the entire progress store",
    description: `This deletes all ${entries.length} entries (${formatBytes(
      bytes
    )}) from the plugin store. It cannot be undone without a backup and prevents future auditing or progress reporting. Type DELETE to confirm.`,
    placeholder: "DELETE",
  });
  if (typed?.trim() !== "DELETE") {
    if (typed !== undefined) {
      context.ui.toast.show({ message: "Store not cleared: confirmation did not match", variant: "warning" });
    }
    return;
  }
  const result = hardDeleteAll();
  setState(readProgressState());
  context.ui.toast.show({
    message: `Store cleared: ${result.removed} ${
      result.removed === 1 ? "entry" : "entries"
    } · ${formatBytes(result.freedBytes)} freed`,
    variant: "success",
  });
}

async function confirmDismissAll(context: TuiContext, roots: TreeNode[]): Promise<void> {
  if (roots.length === 0) return;
  const confirmed = await context.ui.dialog.confirm({
    title: "Dismiss all progress?",
    message: `${roots.length} task${roots.length === 1 ? "" : "s"} will be hidden. Agent updates bring them back.`,
    label: { confirm: "Dismiss all" },
  });
  if (confirmed) dismissRoots(context, roots);
}

type NotesChoice = { kind: "all" } | { kind: "note"; note: SayNote };

async function openNotesDialog(context: TuiContext, sessionIDOverride?: string): Promise<void> {
  const sessionID = sessionIDOverride ?? currentSessionID(context);
  if (!sessionID) {
    context.ui.toast.show({ message: "Open a session to read agent notes", variant: "warning" });
    return;
  }
  const notes = sayNotesForSession(readProgressState(), sessionID);
  if (notes.length === 0) {
    context.ui.toast.show({ message: "No agent notes yet", variant: "info" });
    return;
  }
  const choice = await context.ui.dialog.select<NotesChoice>({
    title: `Agent notes (${notes.length})`,
    placeholder: "Filter notes…",
    options: [
      {
        title: `Dismiss all notes (${notes.length})`,
        value: { kind: "all" as const },
        description: "Remove every note in this session tree",
      },
      ...notes.map((note) => {
        const time = Number.isFinite(note.at)
          ? new Date(note.at).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "";
        const eta = note.eta ? ` · ETA ${note.eta}` : "";
        const prefix = noteAuthorPrefix(note, sessionID);
        return {
          title: `✕ ${time ? `[${time}] ` : ""}${note.kind}: ${prefix}${oneLineText(
            note.text
          )}`,
          value: { kind: "note" as const, note },
          description: `${note.kind}${eta}${prefix ? ` · ${prefix.trim()}` : ""} · select to dismiss`,
        };
      }),
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

  if (choice.kind === "all") {
    const confirmed = await context.ui.dialog.confirm({
      title: "Dismiss all notes?",
      message: `${notes.length} note${notes.length === 1 ? "" : "s"} will be removed for every client.`,
      label: { confirm: "Dismiss all notes" },
    });
    if (!confirmed) return;
    const removed = clearSayNotes(sessionID);
    setState(readProgressState());
    context.ui.toast.show({
      message:
        removed > 0
          ? `Dismissed ${removed} note${removed === 1 ? "" : "s"}`
          : "No notes to dismiss",
      variant: removed > 0 ? "success" : "info",
    });
    return;
  }

  const confirmed = await context.ui.dialog.confirm({
    title: "Dismiss this note?",
    message: formatNotesDialog([choice.note], { viewerSessionID: sessionID }),
    label: { confirm: "Dismiss note" },
  });
  if (!confirmed) return;
  const ok = dismissSayNote(choice.note.id);
  setState(readProgressState());
  context.ui.toast.show({
    message: ok ? "Note dismissed" : "Note already dismissed",
    variant: ok ? "success" : "info",
  });
}

async function openProgressDialog(context: TuiContext): Promise<void> {
  const sessionID = currentSessionID(context);
  if (!sessionID) {
    context.ui.toast.show({ message: "Open a session to manage progress", variant: "warning" });
    return;
  }
  const roots = rootsForSession(sessionID);
  const notes = sayNotesForSession(readProgressState(), sessionID);
  if (roots.length === 0 && notes.length === 0) {
    context.ui.toast.show({ message: "No progress to show", variant: "info" });
    return;
  }

  const done = roots.filter((root) => root.status === "done");
  const expanded = expandedFor(sessionID);
  const choice = await context.ui.dialog.select<ProgressChoice>({
    title: "Progress",
    placeholder: "Filter tasks…",
    options: [
      ...(notes.length > 0
        ? [{ title: `Notes (${notes.length})`, value: { kind: "notes" as const } }]
        : []),
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
  if (choice.kind === "notes") {
    await openNotesDialog(context, sessionID);
    return;
  }
  if (choice.kind === "done") {
    dismissRoots(context, done);
    return;
  }
  if (choice.kind === "all") {
    await confirmDismissAll(context, roots);
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

    sidebarRows = normalizeSidebarRows(context.options?.tuiSidebarRows);

    // `sayModes` projection for this TUI view: `pill` folds into the tree line.
    // The first poll for a session only primes the seen set, so notes that
    // already existed when the view mounted never raise a toast.
    const saySurfaces = tuiSaySurfaces(normalizeSayOptions(context.options).modes);
    sayLineEnabled = saySurfaces.line;
    const seenNotes = new Map<string, Set<string>>();
    sayToastHook = (next) => {
      if (!saySurfaces.toast) return;
      const sessionID = currentSessionID(context);
      if (!sessionID) return;
      const notes = sayNotesForSession(next, sessionID);
      const current = new Set(notes.map((note) => note.id));
      const seen = seenNotes.get(sessionID);
      if (!seen) {
        seenNotes.set(sessionID, current);
        return;
      }
      for (const id of [...seen]) {
        if (!current.has(id)) seen.delete(id);
      }
      const fresh = notes
        .filter((note) => !seen.has(note.id))
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
      for (const note of fresh) {
        seen.add(note.id);
        const toast = buildNoteToast(note, sessionID);
        context.ui.toast.show({
          message: toast.message,
          variant: toast.warning ? "warning" : "info",
        });
      }
    };

    const [capStore, updateCap] = context.storage.memory("tuiMaxRoots", {
      initial: { value: normalizeMaxRoots(context.options?.tuiMaxRoots) },
    });
    rootCapState = capStore;
    setRootCap = updateCap;

    const [layoutStore, updateStoredLayout] = context.storage.memory("tuiLayout", {
      initial: { mode: normalizeTuiLayout(context.options?.tuiLayout) },
    });
    layoutState = layoutStore;
    setLayout = updateStoredLayout;

    const [collapsedStore, updateCollapsed] = context.storage.memory("tuiCollapsed", {
      initial: { value: false },
    });
    collapsedState = collapsedStore;
    setCollapsed = updateCollapsed;

    const stopPolling = startPolling(normalizeRefreshMs(context.options));
    if (context.options?.notifyOnLoad === true) {
      context.ui.toast.show({ message: "Progress plugin loaded", variant: "success" });
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "progress.open",
          title: "Progress: expand or dismiss",
          description: "Browse progress roots; expand a tree or dismiss tasks",
          group: "progress",
          bind: "alt+p",
          palette: true,
          slash: { name: "progress", arguments: true },
          run: (input) => {
            if ((input ?? "").trim().toLowerCase() === "swap-layout") {
              swapLayout(context);
              return;
            }
            return openProgressDialog(context);
          },
        },
        {
          id: "progress.swap-layout",
          title: "Progress: swap layout (composer/sidebar)",
          description: "Move the progress tree above the prompt or into the sidebar",
          group: "progress",
          palette: true,
          run: () => swapLayout(context),
        },
        {
          id: "progress.set-root-cap",
          title: "Progress: set root cap",
          description: "Choose how many root tasks the TUI shows",
          group: "progress",
          palette: true,
          run: () => promptRootCap(context),
        },
        {
          id: "progress.toggle-collapsed",
          title: "Progress: collapse or expand tree",
          description: "Toggle between the progress tree and a one-line status summary",
          group: "progress",
          palette: true,
          run: () => toggleCollapsed(context),
        },
        {
          id: "progress.clear",
          title: "Progress: clear list (this session)",
          description: "Hide finished and dismissed entries; records stay on disk",
          group: "progress",
          palette: true,
          enabled: () => Boolean(currentSessionID(context)),
          run: () => clearList(context),
        },
        {
          id: "progress.hard-clear-session",
          title: "Progress: hard clear this session",
          description: "Permanently delete this session's progress entries",
          group: "progress",
          palette: true,
          enabled: () => Boolean(currentSessionID(context)),
          run: () => hardClearSessionCommand(context),
        },
        {
          id: "progress.hard-clear-store",
          title: "Progress: hard clear entire progress store",
          description: "Delete all progress entries; requires typing DELETE",
          group: "progress",
          palette: true,
          run: () => hardClearStoreCommand(context),
        },
        {
          id: "progress.toggle-tasklist-view",
          title: "Progress: task-list mirror view (match UI/raw)",
          description: "Toggle the Markdown task list between the UI view and the raw store view",
          group: "progress",
          palette: true,
          enabled: () => taskListStatus()?.enabled === true,
          run: () => {
            const current = taskListStatus();
            const mode = toggleTaskListModePref(current?.mode ?? "ui");
            if (current) setTaskListStatus({ ...current, mode });
            context.ui.toast.show({
              message:
                mode === "raw"
                  ? "Task-list mirror: raw store view"
                  : "Task-list mirror: matching the UI",
              variant: "success",
            });
          },
        },
      ],
    }));

    const unregisterComposer = context.ui.slot({
      append: "session.composer.top",
      render: ({ sessionID }) => (
        <Show when={layoutState.mode === "composer"}>
          <ProgressTree sessionID={sessionID} capacity={maxRows} variant="composer" />
        </Show>
      ),
    });
    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => (
        <Show when={layoutState.mode === "sidebar"}>
          <ProgressTree sessionID={sessionID} capacity={sidebarRows} variant="sidebar" />
        </Show>
      ),
    });
    const unregisterFooter = context.ui.slot({
      append: "home.footer.status",
      render: () => <FooterStatus />,
    });

    return () => {
      sayToastHook = undefined;
      sayLineEnabled = true;
      unregisterComposer?.();
      unregisterSidebar?.();
      unregisterFooter?.();
      stopPolling();
    };
  },
});
