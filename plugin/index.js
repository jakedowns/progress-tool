/**
 * OpenCode Progress Plugin - Server Side
 *
 * Provides desktop GUI support for the progress tool.
 * Reads progress state shared with the progress-mcp-server and
 * makes it available to the GUI bundle via plugin storage.
 *
 * Tree-like dependencies (bootvine-inspired):
 *   Entries may carry a `parentId`, forming a dependency tree.
 *   The server rolls up parent status/progress from children.
 *
 * Install:
 *   opencode plugin add /path/to/opencode-progress-plugin
 */

const fs = require('fs');
const path = require('path');

const STATE_FILE =
  process.env.PROGRESS_STATE_PATH ||
  path.join(
    process.env.HOME || process.env.USERPROFILE || '/tmp',
    '.opencode-progress-state.json'
  );

function ensureStateFile() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  } catch (e) {}
  if (!fs.existsSync(STATE_FILE)) {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify({ entries: {}, version: 2 }, null, 2), {
        flag: 'wx',
      });
    } catch (e) {
      // Another process created it first; that is fine.
    }
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { entries: {}, version: 2 };
  }
}

/**
 * Plugin setup function called by OpenCode host.
 * @param {object} context - Plugin context provided by OpenCode
 * @param {object} context.apis - Host APIs (storage, toast, notify, layout, etc.)
 */
function setup(context) {
  const { apis } = context;
  const rawOptions = (context && context.options) || {};
  const refreshMs =
    typeof rawOptions.refreshMs === 'number' && rawOptions.refreshMs >= 100
      ? rawOptions.refreshMs
      : 1000;

  // Shared storage between server-side plugin and GUI bundle
  const progressStore = apis.storage('progress-plugin', 'progress', {
    entries: {},
    version: 2,
  });

  // Initial read
  ensureStateFile();
  progressStore.set(readState());

  // Poll the shared state file written by the MCP server
  let timer = null;
  function pollProgress() {
    try {
      const state = readState();
      progressStore.set(state);
    } catch (e) {
      // Silently ignore read errors
    }
  }

  pollProgress();
  timer = setInterval(pollProgress, refreshMs);

  // Also show toast notifications for new progress entries
  const seen = new Set();
  function checkToasts() {
    try {
      const state = readState();
      const entries = state.entries || {};
      for (const [id, entry] of Object.entries(entries)) {
        if (seen.has(id)) continue;
        seen.add(id);
        // Only toast on root-level entries (no parentId) to avoid noise
        if (entry.parentId) continue;
        if (entry.status === 'error') {
          apis.toast?.show?.({
            title: `Progress: ${entry.title}`,
            description: entry.detail || '',
            variant: 'error',
            persistent: false,
            duration: 5000,
          });
        } else if (entry.status === 'done') {
          apis.toast?.show?.({
            title: `Progress: ${entry.title}`,
            description: entry.detail || 'Completed',
            variant: 'success',
            persistent: false,
            duration: 3000,
          });
        }
      }
    } catch (e) {}
  }

  const toastTimer = setInterval(checkToasts, refreshMs * 2);

  return {
    dispose() {
      if (timer) clearInterval(timer);
      if (toastTimer) clearInterval(toastTimer);
    },
  };
}

module.exports = { setup };
