#!/usr/bin/env node
/**
 * Progress Desktop GUI - Local HTTP Server
 *
 * Serves the progress state file and the desktop GUI HTML page.
 * Run alongside OpenCode to display floating progress indicators.
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
    width: 320px;
    pointer-events: none;
  }
  .progress-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 10px 14px;
    border-radius: 10px;
    background: rgba(255, 255, 255, 0.92);
    border: 1px solid rgba(0, 0, 0, 0.08);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.08);
    margin-bottom: 8px;
    font-size: 13px;
    pointer-events: auto;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    animation: slideIn 0.25s ease-out;
  }
  @keyframes slideIn {
    from { opacity: 0; transform: translateY(-10px); }
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
  .detail {
    font-size: 11px;
    opacity: 0.7;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: #6b7280;
    margin-top: 3px;
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
  } catch (e) {
    // Silently ignore
  }
}

function render() {
  const entries = state.entries || {};
  const items = Object.values(entries)
    .filter(e => !closedIds.has(e.id))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

  container.innerHTML = '';

  if (items.length === 0) {
    emptyDiv.style.display = 'block';
    return;
  }
  emptyDiv.style.display = 'none';

  const active = items.filter(e => e.status === 'running' || e.status === 'waiting');
  const completed = items.filter(e => e.status === 'done' || e.status === 'error');

  [...active, ...completed.slice(0, 3)].forEach(entry => {
    const div = document.createElement('div');
    div.className = 'progress-item';
    const pct = entry.progress != null ? Math.round(entry.progress * 100) : null;
    const elapsed = entry.updatedAt
      ? Math.max(0, Math.round((Date.now() - entry.updatedAt) / 1000)) + 's ago'
      : '';

    div.innerHTML = \`
      <div class="dot \${entry.status}"></div>
      <div class="content">
        <div class="title">\${escapeHtml(entry.title)}</div>
        \${entry.detail
          ? \`<div class="detail">\${escapeHtml(entry.detail)} \${elapsed ? '(' + elapsed + ')' : ''}</div>\`
          : elapsed ? \`<div class="detail">\${elapsed}</div>\` : ''}
      </div>
      \${pct != null ? \`<div class="progress-pct">\${pct}%</div>\` : ''}
      <button class="close-btn" onclick="closeItem('\${escapeAttr(entry.id)}')"></button>
    \`;
    container.appendChild(div);
  });
}

function closeItem(id) {
  closedIds.add(id);
  render();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function escapeAttr(text) {
  return String(text).replace(/'/g, "\\\\'");
}

fetchState();
setInterval(fetchState, 2000);

// Also refresh when window gains focus
window.addEventListener('focus', fetchState);
</script>
</body>
</html>`;

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    return { entries: {}, version: 1 };
  }
}

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