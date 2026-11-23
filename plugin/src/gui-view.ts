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
