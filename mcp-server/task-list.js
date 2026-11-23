'use strict';

/**
 * Optional local task-list mirror.
 *
 * When enabled, every state-store write also renders the current session's
 * task tree to a Markdown checklist. It is intentionally cheap and
 * deterministic: relay ticks that only change progress/updatedAt produce
 * identical Markdown, so the file is not rewritten at telemetry rates.
 *
 * Enable with PROGRESS_TASKLIST=1 (or by setting PROGRESS_TASKLIST_PATH).
 * Relative paths resolve from the MCP server's working directory. Default:
 * `${cwd}/${sessionID}-tasklist.md`.
 *
 *   PROGRESS_TASKLIST_ORDER=newest-first | oldest-first
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_ORDER = 'newest-first';
const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

function isTruthy(value) {
  return typeof value === 'string' && TRUTHY.has(value.trim().toLowerCase());
}

function taskListConfig(env = process.env, cwd = process.cwd()) {
  const configuredPath =
    typeof env.PROGRESS_TASKLIST_PATH === 'string' ? env.PROGRESS_TASKLIST_PATH.trim() : '';
  const enabled = isTruthy(env.PROGRESS_TASKLIST) || configuredPath.length > 0;
  const order =
    String(env.PROGRESS_TASKLIST_ORDER || '').trim().toLowerCase() === 'oldest-first'
      ? 'oldest-first'
      : DEFAULT_ORDER;
  const sessionID = String(env.PROGRESS_SESSION_ID || env.OPENCODE_SESSION_ID || '').trim();
  return { enabled, configuredPath, order, sessionID, cwd };
}

function safeName(value) {
  const cleaned = String(value || 'shared')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 120);
  return cleaned || 'shared';
}

function resolveTaskListPath(config) {
  const fallback = `${safeName(config.sessionID)}-tasklist.md`;
  const configured = config.configuredPath;
  if (!configured) return path.join(config.cwd, fallback);
  const resolved = path.resolve(config.cwd, configured);
  if (/[\\/]$/.test(configured)) return path.join(resolved, fallback);
  try {
    if (fs.statSync(resolved).isDirectory()) return path.join(resolved, fallback);
  } catch {
    // Missing path: treat it as a file.
  }
  return resolved;
}

function timestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function iso(value) {
  const numeric = timestamp(value);
  return numeric ? new Date(numeric).toISOString() : '';
}

function oneLine(value, max = 300) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function escapeInline(value) {
  return oneLine(value, 200).replace(/([\\*`_[\]])/g, '\\$1');
}

function sortEntries(entries, order) {
  const direction = order === 'oldest-first' ? 1 : -1;
  return entries.slice().sort((left, right) => {
    const byTime = (timestamp(left.createdAt) - timestamp(right.createdAt)) * direction;
    if (byTime !== 0) return byTime;
    return String(left.id).localeCompare(String(right.id));
  });
}

/**
 * Render a state document as Markdown. Pure: no filesystem access.
 */
function renderTaskList(state, options = {}) {
  const sessionID = options.sessionID || '';
  const order = options.order === 'oldest-first' ? 'oldest-first' : DEFAULT_ORDER;
  const all = Object.values((state && state.entries) || {}).filter(
    (entry) => entry && typeof entry === 'object'
  );
  const entries = sessionID
    ? all.filter((entry) => !entry.sessionId || entry.sessionId === sessionID)
    : all;

  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const children = new Map();
  const roots = [];
  for (const entry of entries) {
    if (entry.parentId && byId.has(entry.parentId)) {
      const list = children.get(entry.parentId) || [];
      list.push(entry);
      children.set(entry.parentId, list);
    } else {
      roots.push(entry);
    }
  }

  const lines = [
    `# Task list — ${sessionID || 'shared session'}`,
    '',
    `_Mirrored from progress-tool. ${order === 'oldest-first' ? 'Oldest' : 'Newest'} first. Do not edit by hand._`,
    '',
  ];

  if (entries.length === 0) {
    lines.push('_No tasks yet._');
  } else {
    const seen = new Set();
    const renderEntry = (entry, depth) => {
      if (seen.has(entry.id) || depth > 20) return;
      seen.add(entry.id);
      const checked = entry.status === 'done' ? 'x' : ' ';
      const created = iso(entry.createdAt);
      const updated = iso(entry.statusUpdatedAt || entry.updatedAt || entry.createdAt);
      const meta = [
        entry.status || 'unknown',
        created ? `created ${created}` : '',
        updated ? `updated ${updated}` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      lines.push(
        `${'  '.repeat(depth)}- [${checked}] **${escapeInline(entry.title || entry.id)}** — ${meta}`
      );
      const detail = oneLine(entry.detail);
      if (detail) lines.push(`${'  '.repeat(depth + 1)}  ${detail}`);
      for (const child of sortEntries(children.get(entry.id) || [], order)) {
        renderEntry(child, depth + 1);
      }
    };
    for (const root of sortEntries(roots, order)) renderEntry(root, 0);
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Render and write the mirror when it changed. Best-effort: never throws.
 * Returns { written, file?, reason? }.
 */
function syncTaskList(state, options = {}) {
  const config = taskListConfig(options.env || process.env, options.cwd || process.cwd());
  if (options.sessionID) config.sessionID = String(options.sessionID);
  if (!config.enabled) return { written: false, reason: 'disabled' };

  const file = resolveTaskListPath(config);
  const content = renderTaskList(state, config);
  let previous = null;
  try {
    previous = fs.readFileSync(file, 'utf8');
  } catch {
    // First write (or unreadable): fall through.
  }
  if (previous === content) return { written: false, file, reason: 'unchanged' };

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, content, 'utf8');
    fs.renameSync(tmp, file);
    return { written: true, file };
  } catch (error) {
    return { written: false, file, reason: 'error', error: String(error) };
  }
}

module.exports = {
  taskListConfig,
  resolveTaskListPath,
  renderTaskList,
  syncTaskList,
};
