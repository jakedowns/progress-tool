/**
 * Reminder-engine regression tests: severity, one-standing-entry dedupe,
 * compact ages, healthy waiting, target selection, and model-step counting.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-reminders-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
for (const name of ['reminders', 'monitor']) {
  execFileSync(
    path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
    [
      path.join(ROOT, 'src', `${name}.ts`),
      '--bundle',
      '--format=cjs',
      '--platform=node',
      `--outfile=${path.join(OUT, `${name}.cjs`)}`,
    ],
    { stdio: 'pipe' }
  );
}
const {
  formatReminder,
  reminderHash,
  shouldReplaceReminder,
  formatAge,
  isHealthyWaiting,
  pickTarget,
  normalizeSeverity,
  reminderGapAllows,
} = require(path.join(OUT, 'reminders.cjs'));
const { observeToolCall, idleReminder, staleProgressNudge } = require(
  path.join(OUT, 'monitor.cjs')
);

const monitor = (overrides = {}) => ({
  count: 0,
  nudged: false,
  callsSinceProgress: 0,
  lastStaleNudgeAt: 0,
  staleNudges: 0,
  escalated: false,
  nudgedAt: 0,
  ...overrides,
});

test('severity: normalizes unknown tiers and renders one prefix', () => {
  assert.equal(normalizeSeverity('block'), 'block');
  assert.equal(normalizeSeverity('info'), 'info');
  assert.equal(normalizeSeverity('nope'), 'warn');
  assert.equal(normalizeSeverity(undefined), 'warn');
  assert.equal(formatReminder('warn', '  too   many\nspaces '), '[warn] too many spaces');
});

test('one standing key: same text never repeats; higher severity wins; lower cannot overwrite', () => {
  const warnText = formatReminder('warn', 'update task');
  const warn = { severity: 'warn', text: warnText, hash: reminderHash(warnText) };
  assert.equal(shouldReplaceReminder(undefined, warn), true);
  assert.equal(shouldReplaceReminder(warn, warn), false, 'identical text is deduped');

  const infoText = formatReminder('info', 'tip');
  assert.equal(
    shouldReplaceReminder(warn, { severity: 'info', text: infoText, hash: reminderHash(infoText) }),
    false,
    'info cannot displace a standing warn'
  );

  const blockText = formatReminder('block', 'stop');
  assert.equal(
    shouldReplaceReminder(warn, { severity: 'block', text: blockText, hash: reminderHash(blockText) }),
    true,
    'block outranks warn'
  );
});

test('age formatting clamps absurd magnitudes', () => {
  assert.equal(formatAge(null), 'unknown');
  assert.equal(formatAge(Number.NaN), 'unknown');
  assert.equal(formatAge(-1), 'unknown');
  assert.equal(formatAge(10_000), 'just now');
  assert.equal(formatAge(12 * 60_000), '12m');
  assert.equal(formatAge(90 * 60_000), '1h');
  assert.equal(formatAge(3 * 60 * 60_000), '> 2h');
});

test('healthy waiting needs a non-empty detail and a fresh touch', () => {
  const now = 1_000_000_000;
  const staleAfterMs = 5 * 60_000;
  assert.equal(
    isHealthyWaiting({ status: 'waiting', detail: 'waiting on CI', updatedAt: now - 60_000 }, now, staleAfterMs),
    true
  );
  assert.equal(
    isHealthyWaiting({ status: 'waiting', detail: '   ', updatedAt: now - 60_000 }, now, staleAfterMs),
    false,
    'detail-less waiting stays eligible'
  );
  assert.equal(
    isHealthyWaiting({ status: 'waiting', detail: 'waiting on CI', updatedAt: now - 10 * 60_000 }, now, staleAfterMs),
    false,
    'stale waiting stays eligible'
  );
  assert.equal(
    isHealthyWaiting({ status: 'running', detail: 'working', updatedAt: now }, now, staleAfterMs),
    false
  );
  assert.equal(
    isHealthyWaiting({ status: 'waiting', detail: 'waiting', updatedAt: null }, now, staleAfterMs),
    false
  );
});

test('target selection prefers the oldest open entry and skips dismissed/terminal', () => {
  const now = 1_000_000_000;
  const target = pickTarget(
    [
      { id: 'done', status: 'done', updatedAt: now - 60 * 60_000 },
      { id: 'muted', status: 'running', updatedAt: now - 60 * 60_000, dismissed: { at: 1 } },
      { id: 'new', status: 'running', updatedAt: now - 60_000 },
      { id: 'old', status: 'waiting', updatedAt: now - 12 * 60_000 },
    ],
    now
  );
  assert.equal(target.id, 'old');
  assert.equal(target.status, 'waiting');
  assert.equal(target.ageMs, 12 * 60_000);
  assert.equal(pickTarget([{ id: 'done', status: 'done' }], now), undefined);
});

test('model steps: parallel tool calls in one step count once', () => {
  // Step 1 after the last progress write, three tools in that step.
  for (let call = 0; call < 3; call += 1) {
    const result = observeToolCall(
      monitor(),
      { isProgressCall: false, hasActive: false, lastProgressAt: 0, stepsSinceProgress: 1 },
      { threshold: 3 }
    );
    assert.equal(result.action, 'none', `call ${call} stays below threshold`);
  }

  const thirdStep = observeToolCall(
    monitor(),
    { isProgressCall: false, hasActive: false, stepsSinceProgress: 3 },
    { threshold: 3 }
  );
  assert.equal(thirdStep.action, 'nudge', 'three logical steps trigger the nudge');
});

test('a progress write clears the standing reminder and resets steps', () => {
  const standing = monitor({ nudged: true, count: 5, callsSinceProgress: 5, nudgedAt: 1 });
  const cleared = observeToolCall(
    standing,
    { isProgressCall: true, hasActive: true, progressAdvanced: true, stepsSinceProgress: 0 }
  );
  assert.equal(cleared.action, 'clear');
  assert.equal(cleared.count, 0);
  assert.equal(cleared.callsSinceProgress, 0);
});

test('idle reminder excludes fresh-detail waiting but keeps stale waiting', () => {
  const now = 1_000_000_000;
  const fresh = idleReminder(
    { signature: '', lastAt: 0, count: 0 },
    [
      { id: 'ci', status: 'waiting', detail: 'waiting on CI', updatedAt: now - 60_000 },
    ],
    { now, staleAfterMs: 5 * 60_000 }
  );
  assert.equal(fresh.action, 'none', 'healthy waiting is not neglect');

  const stale = idleReminder(
    { signature: '', lastAt: 0, count: 0 },
    [
      { id: 'ci', status: 'waiting', detail: 'waiting on CI', updatedAt: now - 10 * 60_000 },
    ],
    { now, staleAfterMs: 5 * 60_000 }
  );
  assert.equal(stale.action, 'remind');
  assert.match(stale.message, /^\[block\]/);
});

test('stale nudge copy names the target and one action', () => {
  const text = staleProgressNudge(7, { id: 'wr03', status: 'running', ageMs: 12 * 60_000 });
  assert.match(text, /^\[warn\] 7 steps without a progress change/);
  assert.match(text, /wr03 running 12m/);
  assert.match(text, /update detail\/progress or close it/);
  assert.ok(text.length < 220, 'compact one-line copy');
});

test('global gap suppresses non-block reminders but never blocks', () => {
  const now = 1_000_000_000;
  assert.equal(reminderGapAllows(0, now, 60_000, 'warn'), true);
  assert.equal(reminderGapAllows(now - 30_000, now, 60_000, 'warn'), false);
  assert.equal(reminderGapAllows(now - 61_000, now, 60_000, 'warn'), true);
  assert.equal(reminderGapAllows(now - 1_000, now, 60_000, 'block'), true);
  assert.equal(reminderGapAllows(now - 1_000, now, 0, 'info'), true);
});
