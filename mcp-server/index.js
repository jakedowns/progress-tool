#!/usr/bin/env node
/**
 * Progress MCP Server for OpenCode
 *
 * Exposes a `progress` tool that agents can call to signal long-running work
 * without blocking. Implements the proposal from:
 * https://gist.github.com/jakedowns/ddc4eb4817184a074c82c61dc6e7228c
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
    fs.writeFileSync(STATE_FILE, JSON.stringify({ entries: {}, version: 1 }, null, 2));
  }
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { entries: {}, version: 1 };
  }
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Progress entry schema matches the proposal:
// progress({ id, status, title, detail?, progress? })
function upsertProgress(input) {
  const state = readState();
  const now = Date.now();
  const entry = {
    id: input.id,
    status: input.status, // "running" | "done" | "error" | "waiting"
    title: input.title,
    detail: input.detail || null,
    progress: input.progress || null, // 0-1
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
            version: '1.0.0',
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
                'Signal long-running work without blocking. Fire-and-forget progress updates that appear in the OpenCode desktop GUI. Same id updates in place. Never requires a human reply.',
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

        const { id: progressId, status, title, detail, progress } = args;

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

        ensureStateFile();
        upsertProgress({ id: progressId, status, title, detail, progress });

        sendResponse(id, {
          content: [
            {
              type: 'text',
              text: `Progress recorded: ${title} (${status})${detail ? ` - ${detail}` : ''}${progress !== undefined ? ` [${Math.round(progress * 100)}%]` : ''}`,
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
