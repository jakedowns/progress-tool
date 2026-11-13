#!/usr/bin/env node
/**
 * Progress MCP Server for OpenCode
 *
 * Exposes a `progress` tool that agents can call to signal long-running work
 * without blocking. Implements the proposal from:
 * https://gist.github.com/jakedowns/ddc4eb4817184a074c82c61dc6e7228c
 *
 * Tree-like dependencies (bootvine-inspired):
 *   Each progress entry may carry a `parentId`, linking it to a parent task.
 *   The server builds a dependency tree from flat entries and rolls up
 *   parent status/progress from children, so a GUI or TUI can render nested
 *   progress bars like:
 *
 *     ├── build [██████░░░░] 6/10 · compiling SDL2
 *     │   └── link-lib [████░░░░░░] 4/10 · linking libSDL2.a
 *     └── npm-install [██████████] 10/10 · done ✓
 *
 * Usage:
 *   opencode mcp add progress-server -- /path/to/mcp-server/index.js
 */

const { createServer } = require('http');
const fs = require('fs');
const path = require('path');

// Shared state file for progress - read by the OpenCode plugin GUI
const STATE_FILE = path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.opencode-progress-state.json');

// Ensure state file exists
function ensureStateFile() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  } catch (e) {}
  if (!fs.existsSync(STATE_FILE)) {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ entries: {}, version: 2 }, null, 2));
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { entries: {}, version: 2 };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Status severity for roll-up: higher = "more active"/worse
const STATUS_SEVERITY = {
  error: 4,
  running: 3,
  waiting: 2,
  done: 1,
};

function statusOrder(a, b) {
  return STATUS_SEVERITY[b] - STATUS_SEVERITY[a];
}

/**
 * Build a dependency tree from flat entries.
 * Returns roots (entries with no parentId or whose parent is missing)
 * and a map of id -> { children: [...] }.
 */
function buildTree(entries) {
  const byId = new Map(Object.entries(entries));
  const childrenMap = new Map();

  for (const [id, entry] of byId) {
    childrenMap.set(id, []);
  }

  const roots = [];
  for (const [id, entry] of byId) {
    const parentId = entry.parentId;
    if (parentId && byId.has(parentId)) {
      childrenMap.get(parentId).push(id);
    } else {
      roots.push(id);
    }
  }

  // Sort children deterministically: most severe status first, then by updatedAt desc
  for (const [id, childIds] of childrenMap) {
    childIds.sort((a, b) => {
      const ea = byId.get(a);
      const eb = byId.get(b);
      const s = statusOrder(ea.status, eb.status);
      if (s !== 0) return s;
      return (eb.updatedAt || 0) - (ea.updatedAt || 0);
    });
  }

  // Sort roots similarly
  roots.sort((a, b) => {
    const ea = byId.get(a);
    const eb = byId.get(b);
    const s = statusOrder(ea.status, eb.status);
    if (s !== 0) return s;
    return (eb.updatedAt || 0) - (ea.updatedAt || 0);
  });

  return { byId, childrenMap, roots };
}

/**
 * Recursively roll up a parent entry's status and progress from its children.
 * A parent with no explicit progress of its own derives it from children.
 */
function rollUp(id, entries, childrenMap, cache = new Map()) {
  if (cache.has(id)) return cache.get(id);
  const entry = entries[id];
  if (!entry) return null;

  const childIds = childrenMap.get(id) || [];
  let result = { ...entry };

  if (childIds.length > 0) {
    const childResults = childIds.map((cid) => rollUp(cid, entries, childrenMap, cache));

    // Parent status = most severe child status (unless parent has its own terminal status)
    const childStatuses = childResults.map((r) => r.status);
    if (childStatuses.includes('error')) {
      result.status = 'error';
    } else if (childStatuses.includes('running')) {
      result.status = 'running';
    } else if (childStatuses.includes('waiting')) {
      result.status = 'waiting';
    } else if (childStatuses.every((s) => s === 'done')) {
      result.status = 'done';
    }

    // Parent progress = average of children that have a progress value
    const childProgresses = childResults
      .map((r) => r.progress)
      .filter((p) => p != null);
    if (childProgresses.length > 0 && entry.progress == null) {
      result.progress =
        childProgresses.reduce((a, b) => a + b, 0) / childProgresses.length;
    }

    // Use the most recent child updatedAt as the parent's updatedAt
    const latestChild = childResults.reduce(
      (latest, r) => (r.updatedAt > latest.updatedAt ? r : latest),
      { updatedAt: 0 }
    );
    if (latestChild.updatedAt > (result.updatedAt || 0)) {
      result.updatedAt = latestChild.updatedAt;
    }

    result.children = childResults;
  }

  cache.set(id, result);
  return result;
}

/**
 * Get full tree with roll-ups applied.
 */
function getTree(state) {
  const entries = state.entries || {};
  const { byId, childrenMap, roots } = buildTree(entries);

  const tree = roots.map((id) => rollUp(id, entries, childrenMap));
  return { tree, entries: byId, roots };
}

function upsertProgress(input) {
  const state = readState();
  const now = Date.now();
  const entry = {
    id: input.id,
    status: input.status, // "running" | "done" | "error" | "waiting"
    title: input.title,
    detail: input.detail || null,
    progress: input.progress || null, // 0-1
    parentId: input.parentId || null, // optional tree link
    updatedAt: now,
    createdAt: state.entries[input.id]?.createdAt || now,
  };
  state.entries[input.id] = entry;

  // Clean up old completed entries (older than 10 minutes)
  const cutoff = now - 10 * 60 * 1000;
  for (const [id, e] of Object.entries(state.entries)) {
    if ((e.status === 'done' || e.status === 'error') && e.updatedAt < cutoff) {
      delete state.entries[id];
    }
  }
  writeState(state);
  return entry;
}

function clearProgress(id) {
  const state = readState();
  delete state.entries[id];
  writeState(state);
}

function getAllProgress() {
  return readState();
}

// --- MCP Protocol Implementation (stdio-based) ---

function send(obj) {
  const json = JSON.stringify(obj);
  process.stdout.write(json + '\n');
}

function sendResponse(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } });
}

function sendNotification(method, params) {
  send({ jsonrpc: '2.0', method, params });
}

function handleRequest(req) {
  const { jsonrpc, id, method, params } = req;

  if (jsonrpc !== '2.0') return;

  try {
    switch (method) {
      case 'initialize': {
        sendResponse(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: 'progress-mcp-server',
            version: '2.0.0',
          },
        });
        break;
      }

      case 'initialized': {
        // Notification, no response needed
        break;
      }

      case 'tools/list': {
        sendResponse(id, {
          tools: [
            {
              name: 'progress',
              description:
                'Signal long-running work without blocking. Fire-and-forget progress updates that appear in the OpenCode desktop GUI. Same id updates in place. Never requires a human reply. Optionally pass `parentId` to nest this task under a parent (bootvine-style dependency tree).',
              inputSchema: {
                type: 'object',
                properties: {
                  id: {
                    type: 'string',
                    description: 'Stable id to update or clear a progress entry in place',
                  },
                  status: {
                    type: 'string',
                    enum: ['running', 'done', 'error', 'waiting'],
                    description: 'Current status of the work',
                  },
                  title: {
                    type: 'string',
                    description: 'Short title shown in the progress indicator',
                  },
                  detail: {
                    type: 'string',
                    description: 'Optional detail text (e.g., elapsed time, current step)',
                  },
                  progress: {
                    type: 'number',
                    minimum: 0,
                    maximum: 1,
                    description: 'Optional progress fraction (0-1)',
                  },
                  parentId: {
                    type: 'string',
                    description:
                      'Optional id of a parent task this entry nests under, forming a tree (bootvine-style dependency tree)',
                  },
                },
                required: ['id', 'status', 'title'],
                additionalProperties: false,
              },
            },
          ],
        });
        break;
      }

      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (name !== 'progress') {
          sendError(id, -32601, `Unknown tool: ${name}`);
          break;
        }

        if (!args || typeof args !== 'object') {
          sendError(id, -32602, 'Invalid arguments: expected an object');
          break;
        }

        const { id: progressId, status, title, detail, progress, parentId } = args;

        if (!progressId || typeof progressId !== 'string') {
          sendError(id, -32602, 'Missing required argument: id (string)');
          break;
        }
        if (!status || !['running', 'done', 'error', 'waiting'].includes(status)) {
          sendError(id, -32602, 'Missing or invalid argument: status (running|done|error|waiting)');
          break;
        }
        if (!title || typeof title !== 'string') {
          sendError(id, -32602, 'Missing required argument: title (string)');
          break;
        }
        if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
          sendError(id, -32602, 'Invalid argument: parentId must be a string');
          break;
        }

        ensureStateFile();
        upsertProgress({ id: progressId, status, title, detail, progress, parentId });

        sendResponse(id, {
          content: [
            {
              type: 'text',
              text: `Progress recorded: ${title} (${status})${detail ? ` - ${detail}` : ''}${progress !== undefined ? ` [${Math.round(progress * 100)}%]` : ''}${parentId ? ` ← ${parentId}` : ''}`,
            },
          ],
        });
        break;
      }

      default:
        sendError(id, -32601, `Unknown method: ${method}`);
    }
  } catch (err) {
    sendError(id, -32603, 'Internal error', String(err.message));
  }
}

// Read JSON-RPC messages from stdin line by line
let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const req = JSON.parse(line);
      handleRequest(req);
    } catch (e) {
      // Ignore parse errors
    }
  }
});

process.stdin.on('end', () => {
  process.exit(0);
});

// Initialize state file on startup
ensureStateFile();
