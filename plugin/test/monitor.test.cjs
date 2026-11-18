/**
 * Strict-mode monitor decision tests. monitor.ts is TypeScript, so it is
 * transpiled to CJS with esbuild before requiring it.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-monitor-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'monitor.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${path.join(OUT, 'monitor.cjs')}`],
  { stdio: 'pipe' }
);
const {
  observeToolCall,
  normalizeStrictMode,
  normalizeStaleAfterMs,
  silentRunNudge,
  staleProgressNudge,
} = require(path.join(OUT, 'monitor.cjs'));

const idle = () => ({ count: 0, callsSinceProgress: 0, nudged: false, forced: false, lastStaleNudgeAt: 0 });

test('off disables everything', () => {
  const step = observeToolCall(idle(), { isProgressCall: false, hasActive: false }, { strictMode: 'off' });
  assert.equal(step.action, 'none');
  assert.equal(step.count, 0);
});

test('silent-run: nudges at the threshold, once, then clears on a progress call', () => {
  const monitor = idle();
  const opts = { strictMode: 'nudge', threshold: 3 };
  let step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'none');
  monitor.count = step.count;
  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'none');
  monitor.count = step.count;
  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'nudge');
  monitor.count = step.count;
  monitor.nudged = true;

  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'none', 'does not re-nudge while standing');

  step = observeToolCall(monitor, { isProgressCall: true, hasActive: true }, opts);
  assert.equal(step.action, 'clear', 'compliance clears the standing nudge');
});

test('force fires once, then softens to nudge', () => {
  const monitor = idle();
  const opts = { strictMode: 'force', threshold: 2 };
  let step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  monitor.count = step.count;
  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'force');
  monitor.count = step.count;
  monitor.nudged = true;
  monitor.forced = true;

  // Compliance clears the standing nudge…
  step = observeToolCall(monitor, { isProgressCall: true, hasActive: true }, opts);
  assert.equal(step.action, 'clear');
  monitor.nudged = false;
  monitor.count = 0;

  // …but force does not repeat in the same monitor lifetime:
  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  monitor.count = step.count;
  step = observeToolCall(monitor, { isProgressCall: false, hasActive: false }, opts);
  assert.equal(step.action, 'nudge', 'forced already used → soft nudge');
});

test('stale-progress: needs pending tasks, elapsed time, and calls since progress', () => {
  const now = 1_000_000_000;
  const opts = { strictMode: 'nudge', staleAfterMs: 5 * 60 * 1000, cooldownMs: 2 * 60 * 1000, staleMinCalls: 3 };
  const monitor = idle();
  const lastProgressAt = now - 10 * 60 * 1000; // 10 minutes ago

  let step = observeToolCall(monitor, { isProgressCall: false, hasActive: true, lastProgressAt, now }, opts);
  assert.equal(step.action, 'none', 'first call: only 1 call since progress');
  monitor.callsSinceProgress = step.callsSinceProgress;

  step = observeToolCall(monitor, { isProgressCall: false, hasActive: true, lastProgressAt, now: now + 1000 }, opts);
  assert.equal(step.action, 'none');
  monitor.callsSinceProgress = step.callsSinceProgress;

  step = observeToolCall(monitor, { isProgressCall: false, hasActive: true, lastProgressAt, now: now + 2000 }, opts);
  assert.equal(step.action, 'stale-nudge');
  monitor.lastStaleNudgeAt = step.lastStaleNudgeAt;

  // Within cooldown: quiet.
  step = observeToolCall(
    { ...monitor, nudged: true },
    { isProgressCall: false, hasActive: true, lastProgressAt, now: now + 30_000 },
    opts
  );
  assert.equal(step.action, 'none');

  // After cooldown: nudge again.
  step = observeToolCall(
    { ...monitor, nudged: true },
    { isProgressCall: false, hasActive: true, lastProgressAt, now: now + 4 * 60 * 1000 },
    opts
  );
  assert.equal(step.action, 'stale-nudge');
});

test('relay activity (progressAdvanced) resets the stale counter', () => {
  const now = 1_000_000_000;
  const opts = { strictMode: 'nudge', staleAfterMs: 5 * 60 * 1000, staleMinCalls: 3 };
  const monitor = { ...idle(), callsSinceProgress: 5 };
  const step = observeToolCall(
    monitor,
    { isProgressCall: false, hasActive: true, lastProgressAt: now - 10 * 60 * 1000, progressAdvanced: true, now },
    opts
  );
  assert.equal(step.action, 'none');
  assert.equal(step.callsSinceProgress, 0);
});

test('recent progress activity never nudges', () => {
  const now = 1_000_000_000;
  const opts = { strictMode: 'nudge', staleAfterMs: 5 * 60 * 1000, staleMinCalls: 1 };
  const step = observeToolCall(
    { ...idle(), callsSinceProgress: 9 },
    { isProgressCall: false, hasActive: true, lastProgressAt: now - 10_000, now },
    opts
  );
  assert.equal(step.action, 'none');
});

test('normalizers and message texts', () => {
  assert.equal(normalizeStrictMode({ strictMode: 'force' }), 'force');
  assert.equal(normalizeStrictMode({ strictMode: 'off' }), 'off');
  assert.equal(normalizeStrictMode({}), 'nudge');
  assert.equal(normalizeStaleAfterMs({ staleAfterMs: 10_000 }), 5 * 60 * 1000, 'below floor → default');
  assert.equal(normalizeStaleAfterMs({ staleAfterMs: 120_000 }), 120_000);

  assert.match(silentRunNudge(4), /STRICT MODE: 4 consecutive tool calls/);
  assert.match(staleProgressNudge(7), /STRICT MODE: 7 tool calls since any progress value changed/);
  assert.match(staleProgressNudge(7), /any updates\?/);
});
