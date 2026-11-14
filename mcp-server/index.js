#!/usr/bin/env node
'use strict';

/**
 * Progress MCP Server for OpenCode (and any MCP-capable harness)
 *
 * Exposes a `progress` tool that agents can call to signal long-running work
 * without blocking. Implements the proposal from:
 * https://gist.github.com/jakedowns/ddc4eb4817184a074c82c61dc6e7228c
 *
 * Zero-token-burn design:
 *   The agent owns milestones and tree structure. High-frequency telemetry
 *   (stdout, percentages, elapsed time) is streamed out-of-band by the
 *   relay CLI, which writes to the same state file. The agent never polls.
 *
 * Tree-like dependencies (bootvine-inspired):
 *   Each progress entry may carry a `parentId`, linking it to a parent task.
 *   Parent status/progress roll up from children so a GUI or TUI can render:
 *
 *     ├── build [██████░░░░] 6/10 · compiling SDL2
 *     │   └── link-lib [████░░░░░░] 4/10 · linking libSDL2.a
 *     └── npm-install [██████████] 10/10 · done ✓
 *
 * Dual-mode entrypoint (same binary, no extra daemon):
 *   node mcp-server/index.js                    # MCP stdio server (default)
 *   node mcp-server/index.js relay --id build-1 -- npm run build
 *   node mcp-server/index.js emit --id build-1 --status running
 *
 * Usage as an MCP server:
 *   opencode mcp add progress-server -- /path/to/mcp-server/index.js
 */

const fs = require('fs');
const path = require('path');

const {
  upsertProgress,
  ensureStateFile,
} = require('./state-store');

const SERVER_VERSION = '2.1.0';
const VALID_STATUSES = ['running', 'waiting', 'done', 'error'];

const SERVER_INSTRUCTIONS = [
  'The `progress` tool is fire-and-forget. Call it at task milestones only:',
  'once when a phase starts (status "running"), once when a child task is',
  'created (parentId), and once when a phase finishes ("done" or "error").',
  'Never poll, sleep, or loop on terminal output to refresh elapsed time or',
  'percentages. For long-running shell commands, use the out-of-band relay',
  'printed in the tool response (for example `progress-relay --id <id> -- <cmd>`),',
  'which updates the GUI at zero token cost. Pass parentId to build a tree;',
  'parent status and progress roll up from children. Concurrent sessions are',
  'isolated automatically via OPENCODE_SESSION_ID / PROGRESS_SESSION_ID, so',
  'keep using clean task IDs like "build-1" instead of manually prefixing them.',
  'Formatting: title and detail may contain line breaks written as real newlines,',
  'as escaped "\\n" / "\\r\\n" (or extra-escaped "\\\\n"), or as "<br>" / "<br/>".',
  'Use line breaks to keep verbose status readable: a short title line plus a',
  'few detail lines. Viewers wrap long lines and scroll long details; do not use',
  'one huge single-line description.',
].join(' ');

const TOOL_DESCRIPTION = [
  'Report non-blocking task progress and dependency trees to the user\'s GUI. Fire-and-forget: never pauses execution or waits for human input.',
  '',
  'OWNERSHIP & ZERO-POLLING CONTRACT:',
  '- You own TASK MILESTONES and TREE STRUCTURE: call this tool once when starting a phase (status: "running"), when creating child sub-tasks (parentId), and when a phase finishes (status: "done" | "error").',
  '- NEVER poll, sleep, or loop on terminal output just to refresh progress percentages or elapsed time.',
  '- For long-running shell commands, delegate live stdout/progress streaming to the out-of-band CLI relay (the exact command is returned in this tool\'s response, e.g. `progress-relay --id <id> -- <cmd>`) so the OS process updates the GUI directly without burning tokens.',
  '',
  'TREE ROLLUP (BOOTVINE SEMANTICS):',
  '- Pass `parentId` to nest sub-tasks under a parent task.',
  '- Parent status and progress automatically roll up from children (any child "error" -> parent "error"; any child "running"/"waiting" -> parent "running"/"waiting"; parent progress = mean of child progress).',
  '',
  'SESSION ISOLATION:',
  '- Concurrent sessions are isolated automatically via OPENCODE_SESSION_ID / PROGRESS_SESSION_ID (or an explicit `sessionId` override).',
  '- Keep using clean task IDs like `build-1`; do NOT manually prefix them with a session ID.',
  '',
  'LINE BREAKS & LONG TEXT:',
  '- `title` and `detail` support multi-line text. Use real newlines, escaped `\\n` / `\\r\\n` (or an extra-escaped `\\\\n`), or `<br>` / `<br/>` tags.',
  '- Keep `title` to a short headline and put verbose context in `detail` across a few lines instead of one huge single-line string.',
  '- Viewers normalize these forms, wrap long lines, and scroll long details. Do not rely on the viewer to split a wall of text for you.',
].join('\n');

// --- Shell / CLI helpers ---------------------------------------------------

function shellQuote(value) {
  const text = String(value);
  if (/^[A-Za-z0-9._:@%+,\/-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

function fileQuote(value) {
  const text = String(value);
  return /^[A-Za-z0-9._:@%+,\/-]+$/.test(text) ? text : JSON.stringify(text);
}

let cachedRelayBin = null;

/**
 * Prefer the installed `progress-relay` bin. If it is not on PATH (common
 * when the MCP server is run from a checkout), fall back to invoking this
 * same file with the `relay` subcommand. Either form works in any shell.
 */
function relayBin() {
  if (process.env.PROGRESS_RELAY_CMD) return process.env.PROGRESS_RELAY_CMD;
  if (cachedRelayBin !== null) return cachedRelayBin;

  const names =
    process.platform === 'win32'
      ? ['progress-relay.cmd', 'progress-relay.exe', 'progress-relay']
      : ['progress-relay'];

  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        cachedRelayBin = 'progress-relay';
        return cachedRelayBin;
      } catch (e) {
        // Keep looking.
      }
    }
  }

  cachedRelayBin = `${fileQuote(process.execPath)} ${fileQuote(__filename)} relay`;
  return cachedRelayBin;
}

function relayHint(id, parentId, sessionId) {
  const bin = relayBin();
  const parent = parentId ? ` --parent ${shellQuote(parentId)}` : '';
  const session = sessionId ? ` --session ${shellQuote(sessionId)}` : '';
  const taskId = shellQuote(id);

  return [
    '',
    'To stream live command output into this indicator without polling, use the out-of-band relay:',
    `  ${bin} --id ${taskId}${parent}${session} -- <cmd>`,
    `  # or: <cmd> | ${bin} --id ${taskId}${session}`,
    'Do NOT poll, sleep, or re-call progress in a loop for elapsed time or percentages.',
    'Concurrent sessions are isolated automatically via OPENCODE_SESSION_ID / PROGRESS_SESSION_ID; keep task IDs clean (e.g. "build-1").',
  ].join('\n');
}

// --- MCP protocol ----------------------------------------------------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function sendResponse(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function sendError(id, code, message, data) {
  send({ jsonrpc: '2.0', id, error: { code, message, data } });
}

function toolOk(id, text) {
  sendResponse(id, {
    content: [{ type: 'text', text }],
    isError: false,
  });
}

function toolError(id, text) {
  sendResponse(id, {
    content: [{ type: 'text', text }],
    isError: true,
  });
}

function handleToolsList(id) {
  sendResponse(id, {
    tools: [
      {
        name: 'progress',
        description: TOOL_DESCRIPTION,
        inputSchema: {
          type: 'object',
          properties: {
            id: {
              type: 'string',
              description:
                'Stable task ID; re-using an ID updates the indicator in place.',
            },
            status: {
              type: 'string',
              enum: VALID_STATUSES,
              description: 'Current lifecycle status of the task.',
            },
            title: {
              type: 'string',
              description:
                'Short human-readable task label. Supports line breaks via real newlines, escaped \\n / \\r\\n, or <br> tags.',
            },
            detail: {
              type: 'string',
              description:
                'Optional status detail, latest step, or multi-line context. Supports line breaks via real newlines, escaped \\n / \\r\\n, or <br> tags; viewers wrap and scroll long text.',
            },
            progress: {
              type: 'number',
              minimum: 0,
              maximum: 1,
              description: 'Optional completion fraction (0.0 to 1.0).',
            },
            parentId: {
              type: 'string',
              description:
                'Optional parent task ID to nest this task in a dependency tree.',
            },
            sessionId: {
              type: 'string',
              description:
                'Optional session ID override; automatically resolved from PROGRESS_SESSION_ID or OPENCODE_SESSION_ID when set by the harness.',
            },
          },
          required: ['id', 'status', 'title'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Progress',
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  });
}

function handleProgressCall(id, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    toolError(id, 'Invalid arguments: expected an object.');
    return;
  }

  const {
    id: progressId,
    status,
    title,
    detail,
    progress,
    parentId,
    sessionId,
  } = args;

  if (!progressId || typeof progressId !== 'string') {
    toolError(id, 'Missing required argument: id (string).');
    return;
  }
  if (!status || !VALID_STATUSES.includes(status)) {
    toolError(id, `Missing or invalid argument: status (${VALID_STATUSES.join('|')}).`);
    return;
  }
  if (!title || typeof title !== 'string') {
    toolError(id, 'Missing required argument: title (string).');
    return;
  }
  if (detail !== undefined && detail !== null && typeof detail !== 'string') {
    toolError(id, 'Invalid argument: detail must be a string.');
    return;
  }
  if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
    toolError(id, 'Invalid argument: parentId must be a string.');
    return;
  }
  if (sessionId !== undefined && sessionId !== null && typeof sessionId !== 'string') {
    toolError(id, 'Invalid argument: sessionId must be a string.');
    return;
  }
  if (
    progress !== undefined &&
    progress !== null &&
    (typeof progress !== 'number' ||
      !Number.isFinite(progress) ||
      progress < 0 ||
      progress > 1)
  ) {
    toolError(id, 'Invalid argument: progress must be a number between 0 and 1.');
    return;
  }

  const entry = upsertProgress({
    id: progressId,
    sessionId,
    status,
    title,
    detail: detail === undefined ? undefined : detail,
    progress: progress === undefined ? undefined : progress,
    parentId: parentId === '' ? null : parentId,
  });

  const parts = [`Recorded progress [${entry.id}] (${entry.status})`, entry.title];
  if (entry.detail) parts.push(entry.detail);
  if (entry.progress != null) parts.push(`${Math.round(entry.progress * 100)}%`);
  if (entry.parentId) parts.push(`parent=${entry.parentId}`);

  let text = parts.join(' - ');
  if (entry.status === 'running') {
    text += relayHint(entry.id, entry.parentId, entry.sessionId);
  }

  toolOk(id, text);
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
            version: SERVER_VERSION,
          },
          instructions: SERVER_INSTRUCTIONS,
        });
        break;
      }

      case 'initialized':
      case 'notifications/initialized': {
        // Notification, no response needed.
        break;
      }

      case 'ping': {
        sendResponse(id, {});
        break;
      }

      case 'tools/list': {
        handleToolsList(id);
        break;
      }

      case 'tools/call': {
        const { name, arguments: args } = params || {};
        if (name !== 'progress') {
          sendError(id, -32601, `Unknown tool: ${name}`);
          break;
        }
        const callArgs = { ...(args && typeof args === 'object' ? args : {}) };
        const metaSession = params?._meta?.['ai.opencode/sessionID'];
        if (
          callArgs.sessionId === undefined &&
          typeof metaSession === 'string' &&
          metaSession
        ) {
          callArgs.sessionId = metaSession;
        }
        handleProgressCall(id, callArgs);
        break;
      }

      case 'shutdown': {
        sendResponse(id, null);
        break;
      }

      case 'exit': {
        process.exit(0);
        break;
      }

      default: {
        // Notifications have no id; never reply to them.
        if (id !== undefined && id !== null) {
          sendError(id, -32601, `Unknown method: ${method}`);
        }
        break;
      }
    }
  } catch (err) {
    if (id !== undefined && id !== null) {
      sendError(id, -32603, 'Internal error', String(err && err.message ? err.message : err));
    }
  }
}

function startMcpServer() {
  ensureStateFile();

  let buffer = '';

  process.stdin.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      try {
        handleRequest(JSON.parse(line));
      } catch (e) {
        // Ignore malformed JSON-RPC lines.
      }
    }
  });

  process.stdin.on('end', () => {
    // Let pending stdout writes drain naturally instead of truncating the
    // final tool response during a client restart.
    process.exitCode = 0;
  });

  // A closed stdout (client restart) should not crash the server.
  process.stdout.on('error', (err) => {
    if (err && err.code === 'EPIPE') process.exit(0);
  });
}

// --- Entrypoint ------------------------------------------------------------

function printHelp() {
  process.stdout.write(
    [
      'progress-mcp-server ' + SERVER_VERSION,
      '',
      'MCP server and out-of-band relay for the `progress` tool.',
      '',
      'Usage:',
      '  node index.js                         Start the MCP stdio server',
      '  node index.js relay --id <id> [--] <cmd...>',
      '                                        Stream command output to state',
      '  node index.js emit --id <id> [--status ...]',
      '                                        Emit one milestone',
      '  node index.js --version               Print version',
      '',
      'Relay options: relay --help',
      '',
    ].join('\n')
  );
}

function main() {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const invokedAs = path.basename(process.argv[1] || '').replace(/\.(js|cjs)$/i, '');

  if (command === 'relay' || command === 'emit') {
    require('./relay').main(argv.slice(1), command);
    return;
  }

  if (!command && /relay/i.test(invokedAs)) {
    require('./relay').main(argv, 'relay');
    return;
  }

  if (!command && /emit/i.test(invokedAs)) {
    require('./relay').main(argv, 'emit');
    return;
  }

  if (command === '--help' || command === '-h' || command === 'help') {
    printHelp();
    return;
  }

  if (command === '--version' || command === '-v') {
    process.stdout.write(SERVER_VERSION + '\n');
    return;
  }

  startMcpServer();
}

main();
