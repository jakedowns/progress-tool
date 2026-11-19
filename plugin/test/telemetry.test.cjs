/**
 * Nudge telemetry tests: JSONL appends, enable/disable rules, path override.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-telemetry-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'telemetry.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${path.join(OUT, 'telemetry.cjs')}`],
  { stdio: 'pipe' }
);
const { logNudge, nudgeLogPath, nudgeLoggingEnabled } = require(path.join(OUT, 'telemetry.cjs'));

test('disabled by default; enabled by option or env', () => {
  const saved = process.env.PROGRESS_NUDGE_LOG;
  delete process.env.PROGRESS_NUDGE_LOG;
  try {
    assert.equal(nudgeLoggingEnabled({}), false);
    assert.equal(nudgeLoggingEnabled({ verboseLogging: false }), false);
    assert.equal(nudgeLoggingEnabled({ verboseLogging: true }), true);
    process.env.PROGRESS_NUDGE_LOG = '/tmp/x.log';
    assert.equal(nudgeLoggingEnabled({}), true);
    assert.equal(nudgeLogPath(), '/tmp/x.log');
  } finally {
    if (saved === undefined) delete process.env.PROGRESS_NUDGE_LOG;
    else process.env.PROGRESS_NUDGE_LOG = saved;
  }
});

test('logNudge appends one JSON line per event with a timestamp', () => {
  const file = path.join(OUT, 'nudges.log');
  process.env.PROGRESS_NUDGE_LOG = file;
  try {
    logNudge({ event: 'wall-clock', sessionID: 'ses_abc', ageMinutes: 2 });
    logNudge({ event: 'strict', action: 'nudge', count: 3 });
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.event, 'wall-clock');
    assert.equal(first.sessionID, 'ses_abc');
    assert.equal(first.ageMinutes, 2);
    assert.ok(first.ts && !Number.isNaN(Date.parse(first.ts)));
    const second = JSON.parse(lines[1]);
    assert.equal(second.event, 'strict');
    assert.equal(second.action, 'nudge');
  } finally {
    delete process.env.PROGRESS_NUDGE_LOG;
  }
});

test('unwritable path never throws', () => {
  process.env.PROGRESS_NUDGE_LOG = '/nonexistent-dir/nope/nudges.log';
  try {
    assert.doesNotThrow(() => logNudge({ event: 'idle-reminder' }));
  } finally {
    delete process.env.PROGRESS_NUDGE_LOG;
  }
});
