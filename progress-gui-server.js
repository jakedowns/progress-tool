#!/usr/bin/env node
/**
 * Progress Desktop GUI - Local HTTP Server
 *
 * Serves the progress state file and the desktop GUI HTML page.
 * Run alongside OpenCode to display floating progress indicators.
 *
 * Tree-like dependencies (bootvine-inspired):
 *   Entries with a `parentId` are rendered nested under their parent,
   forming a dependency tree:
 *
 *     ├── build [██████░░░░] 6/10 · compiling SDL2
 *     │   └── link-lib [████░░░░░░] 4/10 · linking libSDL2.a
 *     └── npm-install [██████████] 10/10 · done ✓
 *
 * Usage:
 *   node progress-gui-server.js [--port 8765] [--state-path /path/to/state.json]
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PROGRESS_GUI_PORT || '8765', 10);
const STATE_FILE = process.env.PROGRESS_STATE_PATH ||
  path.join(process.env.HOME || process.env.USERPROFILE || '/tmp', '.opencode-progress-state.json');

const STATUS_ORDER = { error: 4, running: 3, waiting: 2, done: 1 };

function buildTree(entries) {
  const byId = new Map(Object.entries(entries || {}));
  const childrenMap = new Map();
  for (const [id] of byId) childrenMap.set(id, []);

  const roots = [];
  for (const [id, entry] of byId) {
    const parentId = entry.parentId;
    if (parentId && byId.has(parentId)) {
      childrenMap.get(parentId).push(id);
    } else {
      roots.push(id);
    }
  }

  const sortIds = (a, b) => {
    const ea = byId.get(a);
    const eb = byId.get(b);
    const s = STATUS_ORDER[eb.status] - STATUS_ORDER[ea.status];
    if (s !== 0) return s;
    return (eb.updatedAt || 0) - (ea.updatedAt || 0);
  };

  for (const [id, childIds] of childrenMap) childIds.sort(sortIds);
  roots.sort(sortIds);

  function buildNode(id) {
    const entry = byId.get(id);
    if (!entry) return null;
    const childIds = childrenMap.get(id) || [];
    return { ...entry, children: childIds.map(buildNode).filter(Boolean) };
  }

  return roots.map(buildNode).filter(Boolean);
}

function rollUpTree(tree) {
  // Mutate tree nodes to add rolled-up status/progress from children
  function roll(node) {
    if (!node.children || node.children.length === 0) return node;
    const childResults = node.children.map(roll);
    const statuses = childResults.map((c) => c.status);
    if (statuses.includes('error')) node.status = 'error';
    else if (statuses.includes('running')) node.status = 'running';
    else if (statuses.includes('waiting')) node.status = 'waiting';
    else if (statuses.every((s) => s === 'done')) node.status = 'done';

    const progresses = childResults.map((c) => c.progress).filter((p) => p != null);
    if (progresses.length > 0 && node.progress == null) {
      node.progress = progresses.reduce((a, b) => a + b, 0) / progresses.length;
    }
    const latest = childResults.reduce(
      (latest, c) => (c.updatedAt > latest.updatedAt ? c : latest),
      { updatedAt: 0 }
    );
    if (latest.updatedAt > (node.updatedAt || 0)) node.updatedAt = latest.updatedAt;
    return node;
  }
  return tree.map(roll);
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { entries: {}, version: 2 };
  }
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OpenCode Progress</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    background: transparent;
    overflow: hidden;
  }
  #progress-container {
    position: fixed;
    top: 14px;
    right: 14px;
    z-index: 2147483647;
    display: flex;
    flex-direction: column;
    gap: 8px;
    width: 340px;
    pointer-events: none;
  }
  .progress-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    padding-left: 12px;
    border-radius: 8px;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(0, 0, 0, 0.08);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.12);
    margin-bottom: 6px;
    font-size: 13px;
    pointer-events: auto;
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
    animation: slideIn 0.25s ease-out;
  }
  .progress-item.child {
    background: transparent;
    box-shadow: none;
    border: none;
    padding-left: 28px;
    opacity: 0.9;
  }
  @keyframes slideIn {
    from { opacity: 0; transform: translateY(-8px); }
    to { opacity: 1; transform: translateY(0); }
  }
  .dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot.running { background: #3b82f6; animation: pulse 2s infinite ease-in-out; }
  .dot.waiting { background: #f59e0b; animation: pulse 2s infinite ease-in-out; }
  .dot.done { background: #10b981; }
  .dot.error { background: #ef4444; }
  @keyframes pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50% { opacity: 0.6; transform: scale(1.15); }
  }
  .content { flex: 1; min-width: 0; }
  .title {
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #111827;
  }
  .title.child { font-weight: 500; opacity: 0.9; }
  .detail {
    font-size: 11px;
    opacity: 0.7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #6b7280;
    margin-top: 2px;
  }
  .detail.child { opacity: 0.6; }
  .detail-elapsed {
    font-size: 11px;
    opacity: 0.5;
    color: #6b7280;
    margin-top: 2px;
  }
  .progress-pct {
    width: 44px;
    text-align: right;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .close-btn {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: none;
    background: transparent;
    color: #9ca3af;
    cursor: pointer;
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .close-btn:hover { background: #f3f4f6; color: #ef4444; }
  .close-btn:before { content: "\\times"; font-size: 16px; line-height: 1; }
  .tree-line {
    font-family: monospace;
    font-size: 13px;
    color: #6b7280;
    flex-shrink: 0;
    user-select: none;
  }
  .empty {
    position: fixed;
    top: 14px;
    right: 14px;
    z-index: 2147483647;
    font-size: 12px;
    color: #9ca3af;
    pointer-events: none;
  }
  @media (prefers-color-scheme: dark) {
    .progress-item {
      background: rgba(17, 24, 39, 0.92);
      border: 1px solid rgba(255, 255, 255, 0.08);
      color: #f9fafb;
    }
    .title { color: #f9fafb; }
    .detail { color: #9ca3af; }
    .close-btn { color: #6b7280; }
    .close-btn:hover { background: rgba(255,255,255,0.1); }
  }
</style>
</head>
<body>
<div id="progress-container"></div>
<div id="empty" class="empty" style="display:none;">No active progress</div>

<script>
const STATE_URL = '/api/progress';
const container = document.getElementById('progress-container');
const emptyDiv = document.getElementById('empty');
const closedIds = new Set();

let state = {};

async function fetchState() {
  try {
    const res = await fetch(STATE_URL);
    if (!res.ok) return;
    state = await res.json();
    render();
  } catch (e) {}
}

function buildTree(entries) {
  const byId = new Map(Object.entries(entries || {}));
  const childrenMap = new Map();
  for (const [id] of byId) childrenMap.set(id, []);
  const roots = [];
  for (const [id, entry] of byId) {
    const parentId = entry.parentId;
    if (parentId && byId.has(parentId)) childrenMap.get(parentId).push(id);
    else roots.push(id);
  }
  const ORDER = { error: 4, running: 3, waiting: 2, done: 1 };
  const sortIds = (a, b) => {
    const ea = byId.get(a);
    const eb = byId.get(b);
    const s = ORDER[eb.status] - ORDER[ea.status];
    if (s !== 0) return s;
    return (eb.updatedAt || 0) - (ea.updatedAt || 0);
  };
  for (const [id, childIds] of childrenMap) childIds.sort(sortIds);
  roots.sort(sortIds);
  function buildNode(id) {
    const entry = byId.get(id);
    if (!entry) return null;
    const childIds = childrenMap.get(id) || [];
    return { ...entry, children: childIds.map(buildNode).filter(Boolean) };
  }
  return roots.map(buildNode).filter(Boolean);
}

function rollUpTree(tree) {
  function roll(node) {
    if (!node.children || node.children.length === 0) return node;
    const childResults = node.children.map(roll);
    const statuses = childResults.map((c) => c.status);
    if (statuses.includes('error')) node.status = 'error';
    else if (statuses.includes('running')) node.status = 'running';
    else if (statuses.includes('waiting')) node.status = 'waiting';
    else if (statuses.every((s) => s === 'done')) node.status = 'done';
    const progresses = childResults.map((c) => c.progress).filter((p) => p != null);
    if (progresses.length > 0 && node.progress == null) {
      node.progress = progresses.reduce((a, b) => a + b, 0) / progresses.length;
    }
    const latest = childResults.reduce(
      (latest, c) => (c.updatedAt > latest.updatedAt ? c : latest),
      { updatedAt: 0 }
    );
    if (latest.updatedAt > (node.updatedAt || 0)) node.updatedAt = latest.updatedAt;
    return node;
  }
  return tree.map(roll);
}

function render() {
  const entries = state.entries || {};
  let tree = buildTree(entries);
  tree = rollUpTree(tree);

  const activeCount = (function countActive(nodes) {
    let c = 0;
    for (const n of nodes) {
      if (n.status === 'running' || n.status === 'waiting') c++;
      c += countActive(n.children || []);
    }
    return c;
  })(tree);

  const totalCount = (function countAll(nodes) {
    let c = 0;
    for (const n of nodes) {
      c++;
      c += countAll(n.children || []);
    }
    return c;
  })(tree);

  if (totalCount === 0) {
    container.innerHTML = '';
    emptyDiv.style.display = 'block';
    return;
  }
  emptyDiv.style.display = 'none';
  container.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'progress-item';
  header.style.background = 'transparent';
  header.style.boxShadow = 'none';
  header.style.border = 'none';
  header.style.padding = '2px 12px 4px 12px';
  header.innerHTML = \`<div style="font-size:11px;opacity:0.7;color:#6b7280;">Active: \${activeCount} / \${totalCount}</div>\`;
  container.appendChild(header);

  function renderNode(node, depth, isLast, prefix) {
    const config = {
      running: { color: '#3b82f6', pulse: true },
      done: { color: '#10b981', pulse: false },
      error: { color: '#ef4444', pulse: false },
      waiting: { color: '#f59e0b', pulse: true },
    }[node.status];

    const pct = node.progress != null ? Math.round(node.progress * 100) : null;
    const elapsed = node.updatedAt
      ? Math.max(0, Math.round((Date.now() - node.updatedAt) / 1000)) + 's ago'
      : '';

    const connector = isLast ? '└── ' : '├── ';
    const lineEl = document.createElement('div');
    lineEl.className = 'tree-line';
    lineEl.textContent = prefix + connector;

    const item = document.createElement('div');
    item.className = 'progress-item' + (depth > 0 ? ' child' : '');
    item.style.opacity = depth > 0 ? '0.9' : '1';
    item.style.paddingLeft = depth > 0 ? (14 + depth * 16) + 'px' : '12px';
    item.style.background = depth > 0 ? 'transparent' : 'rgba(255,255,255,0.92)';
    item.style.boxShadow = depth === 0 ? '0 4px 12px rgba(0,0,0,0.12)' : 'none';
    item.style.border = depth === 0 ? '1px solid rgba(0,0,0,0.08)' : 'none';

    const dot = document.createElement('div');
    dot.className = 'dot ' + node.status;
    dot.style.animation = config.pulse ? 'pulse 2s infinite ease-in-out' : 'none';

    const content = document.createElement('div');
    content.className = 'content';

    const title = document.createElement('div');
    title.className = 'title' + (depth > 0 ? ' child' : '');
    title.textContent = node.title;

    const detail = document.createElement('div');
    const detailText = node.detail
      ? node.detail + (elapsed ? ' (' + elapsed + ')' : '')
      : elapsed;
    if (detailText) {
      detail.className = 'detail' + (depth > 0 ? ' child' : '');
      detail.textContent = detailText;
      content.appendChild(title);
      content.appendChild(detail);
    } else {
      content.appendChild(title);
    }

    const pctDiv = document.createElement('div');
    pctDiv.className = 'progress-pct';
    if (pct != null) pctDiv.textContent = pct + '%';

    item.appendChild(dot);
    item.appendChild(content);
    if (pct != null) item.appendChild(pctDiv);

    const wrapper = document.createElement('div');
    wrapper.style.display = 'flex';
    wrapper.style.alignItems = 'flex-start';
    wrapper.style.gap = '6px';
    wrapper.appendChild(lineEl);
    wrapper.appendChild(item);

    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    if (node.children && node.children.length > 0) {
      node.children.forEach((child, i) => {
        wrapper.appendChild(renderNode(child, depth + 1, i === node.children.length - 1, childPrefix));
      });
    }

    return wrapper;
  }

  tree.forEach((root, i) => {
    container.appendChild(renderNode(root, 0, i === tree.length - 1, ''));
  });
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

fetchState();
setInterval(fetchState, 2000);
window.addEventListener('focus', fetchState);
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(HTML);
    return;
  }

  if (url.pathname === '/api/progress') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readState()));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, () => {
  console.log(`Progress GUI server running at http://localhost:${PORT}`);
  console.log(`Open http://localhost:${PORT} in your browser or desktop app`);
  console.log(`State file: ${STATE_FILE}`);
});

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
