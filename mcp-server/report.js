'use strict';

/**
 * Subagent-usage report — the local, continuous version of Dax's survey
 * (https://gist.github.com/thdxr/bd8a2ae3169e5fa92648f7eedef84c10).
 *
 * Reads the OpenCode database READ-ONLY and reports the general/explore split
 * for child sessions. Node 18 has no built-in sqlite, so this shells out to
 * python3's stdlib sqlite3. No writes, no network.
 *
 *   node mcp-server/index.js report
 */

const { execFileSync } = require('child_process');
const os = require('os');
const path = require('path');

const PY = `
import json, os, sqlite3
db = os.path.expanduser('~/.local/share/opencode/opencode.db')
con = sqlite3.connect('file:' + db + '?mode=ro', uri=True)
cur = con.cursor()
cur.execute("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='session_v2'")
if cur.fetchone()[0] == 0:
    print(json.dumps({'error': 'no session_v2 table'}))
else:
    cur.execute("SELECT agent, COUNT(*) FROM session_v2 WHERE parent_id IS NOT NULL AND agent IN ('general','explore') GROUP BY agent ORDER BY 2 DESC")
    rows = cur.fetchall()
    cur.execute("SELECT COUNT(*) FROM session_v2 WHERE parent_id IS NOT NULL")
    children = cur.fetchone()[0]
    cur.execute("SELECT COUNT(*) FROM session_v2")
    total = cur.fetchone()[0]
    print(json.dumps({'rows': rows, 'children': children, 'sessions': total}))
`;

function runReport(argv = []) {
  const db = path.join(
    process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'),
    'opencode',
    'opencode.db'
  );
  let payload;
  try {
    const out = execFileSync('python3', ['-c', PY], { encoding: 'utf8', timeout: 15000 });
    payload = JSON.parse(out);
  } catch (err) {
    process.stderr.write(
      `progress-report: could not read the OpenCode DB read-only (${err.message}).\n` +
        `Requires python3 (stdlib sqlite3) and ${db}.\n`
    );
    return 1;
  }
  if (payload.error) {
    process.stderr.write(`progress-report: ${payload.error}\n`);
    return 1;
  }

  const rows = payload.rows || [];
  const subTotal = rows.reduce((sum, [, n]) => sum + n, 0);
  const lines = [];
  lines.push(`OpenCode subagent usage (read-only) — ${payload.sessions} sessions, ${payload.children} child sessions`);
  if (subTotal === 0) {
    lines.push('No general/explore subagent sessions recorded yet.');
  } else {
    for (const [agent, n] of rows) {
      lines.push(`  ${agent}: ${n} (${((100 * n) / subTotal).toFixed(1)}%)`);
    }
    lines.push(`  delegation rate: ${(100 * payload.children) / Math.max(1, payload.sessions)}% of sessions spawned a child`);
  }
  process.stdout.write(lines.join('\n') + '\n');
  return 0;
}

module.exports = { runReport };
