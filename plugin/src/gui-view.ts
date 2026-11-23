import type { SayNote } from "./types.js";

/**
 * Desktop GUI tree placement: the composer pill (default) or a pinned tab in
 * the session's side region. Kept dependency-free so the GUI bundle and the
 * node tests can share the same normalizers.
 */

export type GuiLayout = "composer" | "sidebar";

/** Normalize the configured placement; anything but `sidebar` means the composer. */
export function normalizeGuiLayout(value: unknown): GuiLayout {
  return value === "sidebar" ? "sidebar" : "composer";
}

/** Flip between the two placements. */
export function nextGuiLayout(current: GuiLayout): GuiLayout {
  return current === "sidebar" ? "composer" : "sidebar";
}

/** Initial side-region width for the progress panel, in CSS pixels. */
export function normalizeGuiSidebarWidth(value: unknown): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : 360;
  return Math.max(240, Math.min(800, numeric));
}

/**
 * Detail line cap for the pill menu and sidebar rows.
 * `-1` shows the full detail, `0` hides detail (titles only), and `n > 0`
 * clamps to n lines with an ellipsis. Defaults to 1 line; capped at 100.
 */
export function normalizeGuiDetailLines(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1;
  return Math.max(-1, Math.min(100, Math.floor(value)));
}

/** The panel tab id; the host key is `${plugin}:${id}`. */
export const GUI_PROGRESS_PANEL_ID = "progress";


/** Character cap for the notes pill capsule. */
export const NOTES_PILL_MAX_CHARS = 80;

export interface NotesPillView {
  label: string;
  title: string;
  tone?: "warning";
}

/** Author attribution for a note in a menu list. */
export function noteAuthorLabel(
  note: Pick<SayNote, "sessionId" | "agent">,
  viewerSessionID?: string
): string {
  if (!viewerSessionID || note.sessionId === viewerSessionID) return "Agent";
  return note.agent ? `Subagent (${note.agent})` : "Subagent";
}

/**
 * The optional second composer pill: latest note as the capsule, warning tint
 * for blocked/question notes, and a title with the history count.
 */
export function buildNotesPill(
  notes: readonly SayNote[] | undefined,
  options: { maxChars?: number } = {}
): NotesPillView | undefined {
  const list = (notes ?? []).filter((note) => note && String(note.text ?? "").trim());
  if (list.length === 0) return undefined;
  const latest = list.reduce((newest, note) => ((note.at ?? 0) > (newest.at ?? 0) ? note : newest));
  const maxChars = Math.max(
    20,
    Math.min(200, Math.floor(options.maxChars ?? NOTES_PILL_MAX_CHARS))
  );
  const oneLine = String(latest.text).replace(/\s+/g, " ").trim();
  const label =
    oneLine.length <= maxChars
      ? oneLine
      : `${oneLine.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
  const eta = latest.eta ? ` · ETA ${latest.eta}` : "";
  return {
    label,
    title: `${list.length} note${list.length === 1 ? "" : "s"} · latest ${latest.kind}${eta}`,
    ...(latest.kind === "blocked" || latest.kind === "question"
      ? { tone: "warning" as const }
      : {}),
  };
}
