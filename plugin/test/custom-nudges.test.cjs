/**
 * Custom nudge core: normalization, presets, merge/tombstones, criteria,
 * rendering, scheduling, and the dedicated rule stores.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-custom-nudges-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'custom-nudges.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--outfile=${path.join(OUT, 'custom-nudges.cjs')}`,
  ],
  { stdio: 'pipe' }
);
const n = require(path.join(OUT, 'custom-nudges.cjs'));

const now = 1_000_000_000;
const base = {
  id: 'stale-build',
  text: '{id} is stale ({age}) - {action}',
  scope: 'session',
};

function rule(overrides = {}) {
  const result = n.normalizeNudgeRule({ ...base, ...overrides }, overrides.scope ?? 'session');
  assert.equal(result.ok, true, result.errors.join('; '));
  return result.rule;
}

function runtime(r, overrides = {}) {
  return { ...n.emptyNudgeRuntime(r, now), ...overrides };
}

function context(overrides = {}) {
  return {
    now,
    entries: [{ id: 'wr03', status: 'running', title: 'Build', updatedAt: now - 12 * 60_000 }],
    stepsSinceProgress: 0,
    lastProgressAt: now - 12 * 60_000,
    inFlight: false,
    idle: false,
    ...overrides,
  };
}

test('durations parse and format', () => {
  assert.equal(n.parseNudgeDuration('5m'), 300_000);
  assert.equal(n.parseNudgeDuration('2h'), 7_200_000);
  assert.equal(n.parseNudgeDuration('30s'), 30_000);
  assert.equal(n.parseNudgeDuration('1d'), 86_400_000);
  assert.equal(n.parseNudgeDuration(1500), 1500);
  assert.equal(n.parseNudgeDuration('nope'), undefined);
  assert.equal(n.formatNudgeDuration(300_000), '5m');
  assert.equal(n.formatNudgeDuration(7_200_000), '2h');
  assert.equal(n.formatNudgeDuration(0), 'off');
});

test('normalizer: defaults, clamps, and errors', () => {
  const r = rule({});
  assert.equal(r.severity, 'warn');
  assert.equal(r.delivery, 'context-alongside');
  assert.deepEqual(r.trigger, { type: 'interval', everyMs: 300_000 });
  assert.equal(r.cooldownMs, 120_000);
  assert.equal(r.ttlMs, 3_600_000);
  assert.equal(r.maxFires, 0);
  assert.equal(r.enabled, true);

  const clamped = rule({ trigger: { type: 'interval', everyMs: 1000 }, cooldownMs: 1, maxFires: 9999 });
  assert.equal(clamped.trigger.everyMs, 5_000);
  assert.equal(clamped.cooldownMs, 1);
  assert.equal(clamped.maxFires, 1000);

  const badId = n.normalizeNudgeRule({ ...base, id: 'bad/id!' });
  assert.equal(badId.ok, false);
  assert.match(badId.errors.join(' '), /id must be/);

  const badPlaceholder = n.normalizeNudgeRule({ ...base, text: 'hello {nope}' });
  assert.equal(badPlaceholder.ok, false);
  assert.match(badPlaceholder.errors.join(' '), /unknown placeholder/);

  const long = n.normalizeNudgeRule({ ...base, text: 'x'.repeat(400) });
  assert.equal(long.ok, true);
  assert.equal(long.rule.text.length, 240);
  assert.match(long.warnings.join(' '), /truncated/);

  const syntheticWarn = n.normalizeNudgeRule({ ...base, delivery: 'synthetic', severity: 'warn' });
  assert.equal(syntheticWarn.ok, false);
  assert.match(syntheticWarn.errors.join(' '), /requires severity "block"/);
});

test('presets seed delivery, severity, and lifetime', () => {
  const replace = n.buildNudgeRule({ ...base, preset: 'replace' }, 'replace');
  assert.equal(replace.ok, true);
  assert.equal(replace.rule.delivery, 'context-replace');
  assert.equal(replace.rule.severity, 'warn');
  assert.equal(replace.rule.trigger.everyMs, 300_000);

  const block = n.buildNudgeRule({ ...base, preset: 'block' }, 'block');
  assert.equal(block.rule.delivery, 'synthetic');
  assert.equal(block.rule.severity, 'block');
});

test('merge: union across scopes with narrower tombstones', () => {
  const globalRule = rule({ id: 'a', scope: 'global', text: 'global a' });
  const projectRule = rule({ id: 'b', scope: 'project', text: 'project b' });
  const sessionRule = rule({ id: 'c', scope: 'session', text: 'session c' });

  let merged = n.mergeNudgeRules({ global: [globalRule], project: [projectRule], session: [sessionRule] });
  assert.deepEqual(merged.map((r) => r.id), ['c', 'b', 'a'], 'narrower scope first');

  const projectTombstone = { ...projectRule, id: 'a', enabled: false };
  merged = n.mergeNudgeRules({ global: [globalRule], project: [projectTombstone], session: [] });
  assert.deepEqual(merged.map((r) => r.id), [], 'project tombstone mutes global');

  const sessionEnabled = rule({ id: 'a', scope: 'session', text: 'session a' });
  merged = n.mergeNudgeRules({
    global: [globalRule],
    project: [projectTombstone],
    session: [sessionEnabled],
  });
  assert.deepEqual(merged.map((r) => `${r.scope}:${r.id}`), ['session:a'], 'narrower enabled rule wins');
});

test('criteria: AND across categories, OR inside status lists', () => {
  const entries = [
    { id: 'run', status: 'running', updatedAt: now - 20 * 60_000 },
    { id: 'wait', status: 'waiting', updatedAt: now - 20 * 60_000, detail: '' },
    { id: 'fresh-wait', status: 'waiting', updatedAt: now - 60_000, detail: 'waiting on CI' },
    { id: 'done', status: 'done', updatedAt: now - 20 * 60_000 },
  ];
  const statuses = ['running', 'waiting'];
  let match = n.matchNudgeCriteria(
    { statuses, staleAfterMs: 5 * 60_000 },
    context({ entries })
  );
  assert.equal(match.matched, true);
  assert.deepEqual(match.entries.map((e) => e.id), ['run', 'wait'], 'healthy waiting excluded');

  match = n.matchNudgeCriteria(
    { statuses: ['waiting'], staleAfterMs: 5 * 60_000 },
    context({ entries })
  );
  assert.deepEqual(match.entries.map((e) => e.id), ['wait'], 'explicit waiting ignores health carve-out');

  match = n.matchNudgeCriteria(
    { statuses: ['running'], staleAfterMs: 60 * 60_000 },
    context({ entries })
  );
  assert.equal(match.matched, false, 'AND: all criteria must pass');

  match = n.matchNudgeCriteria(
    { statuses: ['pending'], tree: 'nonempty' },
    context({ entries })
  );
  assert.equal(match.matched, false, 'status filter with no entries does not match');
});

test('criteria: global conditions', () => {
  const ctx = context();
  assert.equal(n.matchNudgeCriteria({ inFlight: 'only' }, ctx).reason, 'not-in-flight');
  assert.equal(n.matchNudgeCriteria({ inFlight: 'never' }, { ...ctx, inFlight: true }).reason, 'in-flight');
  assert.equal(n.matchNudgeCriteria({ idleOnly: true }, ctx).reason, 'not-idle');
  assert.equal(n.matchNudgeCriteria({ tree: 'empty' }, ctx).reason, 'tree-nonempty');
  assert.equal(n.matchNudgeCriteria({ tree: 'empty' }, { ...ctx, entries: [] }).matched, true);
  assert.equal(
    n.matchNudgeCriteria({ noProgressAfterMs: 5 * 60_000 }, { ...ctx, now, lastProgressAt: now }).reason,
    'progress-recent'
  );
  assert.equal(
    n.matchNudgeCriteria({ noProgressAfterSteps: 5 }, { ...ctx, stepsSinceProgress: 2 }).reason,
    'steps-below'
  );
});

test('render fills placeholders from the oldest matched entry', () => {
  const r = rule({ text: '{count} open: {id}/{title} ({status}, {age}) - {action}' });
  const text = n.renderNudgeText(
    r,
    [
      { id: 'new', status: 'running', title: 'New', updatedAt: now - 60_000 },
      { id: 'old', status: 'running', title: 'Old', updatedAt: now - 12 * 60_000 },
    ],
    now
  );
  assert.match(text, /^2 open: old\/Old \(running, 12m\)/);
  assert.match(text, /update detail\/progress or close it/);
});

test('scheduler: interval fires once per window and honours cooldown', () => {
  const r = rule({ trigger: { type: 'interval', everyMs: 5 * 60_000 }, cooldownMs: 60_000 });
  const rt = runtime(r, { createdAt: now - 10 * 60_000 });
  let result = n.evaluateNudgeRule(r, rt, context());
  assert.equal(result.fire, true);
  assert.equal(result.runtime.fires, 1);
  assert.match(result.text, /^wr03 is stale \(12m\)/);

  result = n.evaluateNudgeRule(r, result.runtime, context({ now: now + 60_000 }));
  assert.equal(result.fire, false);
  assert.equal(result.reason, 'not-due');

  result = n.evaluateNudgeRule(r, result.runtime, context({ now: now + 5 * 60_000 }));
  assert.equal(result.fire, true);
});

test('scheduler: steps trigger is per step watermark', () => {
  const r = rule({ trigger: { type: 'steps', everySteps: 3 }, cooldownMs: 0, criteria: {} });
  const rt = runtime(r);
  assert.equal(n.evaluateNudgeRule(r, rt, context({ stepsSinceProgress: 2 })).reason, 'not-due');
  let result = n.evaluateNudgeRule(r, rt, context({ stepsSinceProgress: 3 }));
  assert.equal(result.fire, true);
  result = n.evaluateNudgeRule(r, result.runtime, context({ stepsSinceProgress: 3 }));
  assert.equal(result.fire, false, 'same step count does not refire');
  result = n.evaluateNudgeRule(r, result.runtime, context({ stepsSinceProgress: 4 }));
  assert.equal(result.fire, true);
});

test('scheduler: either fires on whichever is due; event fires with cooldown only', () => {
  const either = rule({
    trigger: { type: 'either', everyMs: 60_000, everySteps: 2 },
    cooldownMs: 0,
  });
  assert.equal(
    n.evaluateNudgeRule(either, runtime(either, { createdAt: now - 120_000 }), context({ stepsSinceProgress: 0 })).fire,
    true
  );
  assert.equal(
    n.evaluateNudgeRule(either, runtime(either), context({ stepsSinceProgress: 2 })).fire,
    true
  );

  const event = rule({ trigger: { type: 'event' }, cooldownMs: 30_000 });
  let result = n.evaluateNudgeRule(event, runtime(event), context());
  assert.equal(result.fire, true);
  result = n.evaluateNudgeRule(event, result.runtime, context({ now: now + 10_000 }));
  assert.equal(result.reason, 'cooldown');
});

test('scheduler: TTL, max fires, and in-flight suppression', () => {
  const ttl = rule({ ttlMs: 60_000, trigger: { type: 'event' }, cooldownMs: 0 });
  assert.equal(
    n.evaluateNudgeRule(ttl, runtime(ttl, { createdAt: now - 61_000 }), context()).reason,
    'expired'
  );

  const oneShot = rule({ maxFires: 1, trigger: { type: 'event' }, cooldownMs: 0 });
  const first = n.evaluateNudgeRule(oneShot, runtime(oneShot), context());
  assert.equal(first.fire, true);
  assert.equal(n.evaluateNudgeRule(oneShot, first.runtime, context()).reason, 'expired');

  const warn = rule({ trigger: { type: 'event' }, cooldownMs: 0 });
  assert.equal(n.evaluateNudgeRule(warn, runtime(warn), context({ inFlight: true })).reason, 'in-flight');
  const block = rule({ severity: 'block', trigger: { type: 'event' }, cooldownMs: 0 });
  assert.equal(n.evaluateNudgeRule(block, runtime(block), context({ inFlight: true })).fire, true);
});

test('replace rules suppress built-ins until expired', () => {
  const replace = rule({ delivery: 'context-replace', ttlMs: 60_000 });
  assert.equal(n.ruleSuppressesBuiltins(replace, runtime(replace, { createdAt: now - 10_000 }), now), true);
  assert.equal(n.ruleSuppressesBuiltins(replace, runtime(replace, { createdAt: now - 61_000 }), now), false);
});

test('store: atomic read/write, malformed recovery, and limits', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-nudge-store-'));
  const file = path.join(dir, 'nested', 'progress-nudge.json');
  const r = rule({});
  n.writeNudgeRuleFile(file, [r]);
  const read = n.readNudgeRuleFile(file, 'session');
  assert.equal(read.errors.length, 0);
  assert.equal(read.rules[0].id, 'stale-build');

  fs.writeFileSync(file, '{not json');
  const broken = n.readNudgeRuleFile(file, 'session');
  assert.deepEqual(broken.rules, []);
  assert.deepEqual(broken.errors, []);

  const upserted = n.upsertNudgeRule(file, 'session', rule({ text: 'updated' }));
  assert.equal(upserted.rules.length, 1);
  assert.equal(upserted.rules[0].text, 'updated');

  n.clearNudgeRule(file, 'session', 'stale-build');
  assert.equal(n.readNudgeRuleFile(file, 'session').rules.length, 0);
});

test('store: session rules are scoped by session id and tombstones work', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-nudge-sessions-'));
  const file = path.join(dir, 'sessions.json');
  n.upsertSessionNudgeRule(file, 'ses_a', rule({ id: 'a' }));
  n.upsertSessionNudgeRule(file, 'ses_b', rule({ id: 'b' }));
  assert.deepEqual(n.readSessionNudgeRules(file, 'ses_a').rules.map((r) => r.id), ['a']);
  assert.deepEqual(n.readSessionNudgeRules(file, 'ses_b').rules.map((r) => r.id), ['b']);

  const disabled = n.setSessionNudgeRuleEnabled(file, 'ses_a', 'a', false);
  assert.equal(disabled.rules[0].enabled, false);
  const merged = n.mergeNudgeRules({
    global: [rule({ id: 'a', scope: 'global' })],
    session: n.readSessionNudgeRules(file, 'ses_a').rules,
  });
  assert.equal(merged.length, 0, 'session tombstone mutes global');

  n.clearSessionNudgeRule(file, 'ses_a', 'a');
  assert.equal(n.readSessionNudgeRules(file, 'ses_a').rules.length, 0);
});

test('project root discovery prefers .git/.opencode and falls back', () => {
  const exists = (candidate) =>
    candidate === '/repo/.git' || candidate === '/repo/packages/app/.opencode';
  assert.equal(n.findProjectRoot('/repo/packages/app/src', exists), '/repo/packages/app');
  assert.equal(n.findProjectRoot('/repo/src', exists), '/repo');
  assert.equal(n.findProjectRoot('/tmp/plain', () => false), '/tmp/plain');
});

test('session entry scoping includes descendants', () => {
  const links = {
    child: { parentID: 'root' },
    grandchild: { parentID: 'child' },
    other: { parentID: 'elsewhere' },
  };
  const entries = [
    { id: 'r', sessionId: 'root' },
    { id: 'c', sessionId: 'child' },
    { id: 'g', sessionId: 'grandchild' },
    { id: 'o', sessionId: 'other' },
  ];
  assert.deepEqual(
    n.entriesForSessions(entries, 'self', 'root', links).map((e) => e.id),
    ['r']
  );
  assert.deepEqual(
    n.entriesForSessions(entries, 'children', 'root', links).map((e) => e.id),
    ['r', 'c', 'g']
  );
  assert.equal(n.entriesForSessions(entries, 'all', 'root', links).length, 4);
});
