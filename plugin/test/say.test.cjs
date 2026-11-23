/**
 * Experimental `say` tool tests. say.ts is TypeScript, so it is transpiled to
 * CJS with esbuild before requiring it (same pattern as monitor.test.cjs).
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-say-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'say.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${path.join(OUT, 'say.cjs')}`],
  { stdio: 'pipe' }
);
const {
  clampSayText,
  createSayController,
  decideSay,
  emptySayState,
  normalizeSayOptions,
  normalizeSayText,
  sayEnabled,
  sayResultMessage,
  sayToolDescription,
} = require(path.join(OUT, 'say.cjs'));

const enabled = (overrides = {}) =>
  normalizeSayOptions({ say: true, ...overrides });

test('say is opt-in and defaults are 180-260, 3 per turn, 15s cooldown', () => {
  assert.equal(sayEnabled({}), false);
  assert.equal(sayEnabled({ say: false }), false);
  assert.equal(sayEnabled({ say: true }), true);

  const options = enabled();
  assert.equal(options.minChars, 180);
  assert.equal(options.maxChars, 260);
  assert.equal(options.budgetPerTurn, 3);
  assert.equal(options.cooldownMs, 15_000);
  assert.equal(options.chatNotes, true);
  assert.equal(options.finalGuard, true);
});

test('option clamping keeps min <= max and bounds every numeric field', () => {
  const options = normalizeSayOptions({
    say: true,
    sayMinChars: 5,
    sayMaxChars: 5000,
    sayBudgetPerTurn: 99,
    sayCooldownMs: -1,
  });
  assert.equal(options.minChars, 80);
  assert.equal(options.maxChars, 600);
  assert.equal(options.budgetPerTurn, 10);
  assert.equal(options.cooldownMs, 0);

  const inverted = normalizeSayOptions({ say: true, sayMinChars: 400, sayMaxChars: 200 });
  assert.equal(inverted.maxChars, 400);
});

test('text is normalized to one line', () => {
  assert.equal(normalizeSayText('  checking\n\n the   tests  '), 'checking the tests');
  assert.equal(normalizeSayText(undefined), '');
});

test('over-max notes are clamped at a word boundary and never rejected', () => {
  const text = 'word '.repeat(100).trim();
  const clamped = clampSayText(text, 40);
  assert.ok(clamped.length <= 40, `expected <= 40, got ${clamped.length}`);
  assert.ok(clamped.endsWith('…'));
  assert.ok(!clamped.includes('  '));
});

test('under-min notes are accepted with a warning', () => {
  const options = enabled();
  const { state, decision } = decideSay(emptySayState(), {
    text: 'short note',
    now: 1_000,
    options,
  });
  assert.equal(decision.accept, true);
  assert.match(decision.warning, /shorter than the preferred 180 chars/);
  assert.equal(state.count, 1);
  assert.equal(state.accepted, true);
});

test('over-max notes are accepted, trimmed, and warned', () => {
  const options = enabled({ sayMinChars: 80, sayMaxChars: 100 });
  const { decision } = decideSay(emptySayState(), {
    text: 'x '.repeat(200),
    now: 1_000,
    options,
  });
  assert.equal(decision.accept, true);
  assert.ok(decision.text.length <= 100);
  assert.match(decision.warning, /trimmed to 100 chars/);
});

test('budget caps accepted notes per turn', () => {
  const options = enabled({ sayBudgetPerTurn: 1, sayCooldownMs: 0 });
  const first = decideSay(emptySayState(), { text: 'first note', now: 1_000, options });
  assert.equal(first.decision.accept, true);

  const second = decideSay(first.state, { text: 'second note', now: 2_000, options });
  assert.equal(second.decision.accept, false);
  assert.equal(second.decision.reason, 'budget');
});

test('cooldown rejects notes that arrive too soon', () => {
  const options = enabled({ sayCooldownMs: 15_000 });
  const first = decideSay(emptySayState(), { text: 'first note', now: 1_000, options });
  assert.equal(first.decision.accept, true);

  const tooSoon = decideSay(first.state, { text: 'second note', now: 5_000, options });
  assert.equal(tooSoon.decision.accept, false);
  assert.equal(tooSoon.decision.reason, 'cooldown');

  const later = decideSay(first.state, { text: 'second note', now: 20_000, options });
  assert.equal(later.decision.accept, true);
});

test('repeating the same note inside the cooldown is skipped as duplicate', () => {
  const options = enabled({ sayCooldownMs: 0 });
  const first = decideSay(emptySayState(), { text: 'same note', now: 1_000, options });
  const second = decideSay(first.state, { text: 'same note', now: 2_000, options });
  assert.equal(second.decision.accept, false);
  assert.equal(second.decision.reason, 'duplicate');
});

test('empty notes are skipped, not accepted', () => {
  const { decision } = decideSay(emptySayState(), {
    text: '   \n  ',
    now: 1_000,
    options: enabled(),
  });
  assert.equal(decision.accept, false);
  assert.equal(decision.reason, 'empty');
});

test('accepted result tells the model to keep working and not conclude', () => {
  const message = sayResultMessage({ accept: true, text: 'note' });
  assert.match(message, /Continue working/);
  assert.match(message, /not the final answer/);
});

test('budget and cooldown results point at the progress tool', () => {
  for (const reason of ['budget', 'cooldown']) {
    const message = sayResultMessage({ accept: false, reason, text: 'note' });
    assert.match(message, /progress tool/);
    assert.match(message, /backchannel updates this turn/);
  }
});

test('tool description carries the length range and budget', () => {
  const description = sayToolDescription(enabled());
  assert.match(description, /180–260/);
  assert.match(description, /3 notes per turn/);
  assert.match(description, /ETA/);
  assert.match(description, /Not the final answer/);
});

test('controller fans out to progress then synthetic with resume:false', async () => {
  const calls = [];
  const controller = createSayController(
    enabled({ sayBudgetPerTurn: 1, sayCooldownMs: 0 }),
    {
      synthetic: async (input) => calls.push({ type: 'synthetic', ...input }),
    }
  );

  const result = await controller.tool.execute(
    { text: 'Reading the plugin sources before editing.', kind: 'intent', eta: '~1 min' },
    {
      sessionID: 'ses_say_1',
      progress: async (input) => calls.push({ type: 'progress', ...input }),
    }
  );

  assert.match(result.content, /Noted/);
  assert.deepEqual(calls.map((call) => call.type), ['progress', 'synthetic']);
  assert.equal(calls[0].status, 'Reading the plugin sources before editing.');
  assert.equal(calls[1].resume, false);
  assert.equal(calls[1].sessionID, 'ses_say_1');
  assert.equal(calls[1].metadata.kind, 'agent.note');
  assert.equal(calls[1].metadata.tone, 'intent');
  assert.equal(calls[1].metadata.eta, '~1 min');
  assert.equal(controller.get('ses_say_1').count, 1);
});

test('controller skips synthetic when chat notes are disabled', async () => {
  const calls = [];
  const controller = createSayController(
    enabled({ sayChatNotes: false, sayCooldownMs: 0 }),
    { synthetic: async (input) => calls.push(input) }
  );
  await controller.tool.execute(
    { text: 'A note that should only reach the tool progress line.' },
    { sessionID: 'ses_say_2', progress: async () => {} }
  );
  assert.equal(calls.length, 0);
});

test('controller survives a synthetic failure (progress line already landed)', async () => {
  const controller = createSayController(
    enabled({ sayCooldownMs: 0 }),
    { synthetic: async () => { throw new Error('synthetic down'); } }
  );
  const result = await controller.tool.execute(
    { text: 'A note whose synthetic copy fails.' },
    { sessionID: 'ses_say_3', progress: async () => {} }
  );
  assert.match(result.content, /Noted/);
});

test('reset starts a new turn budget; markGuarded is sticky', async () => {
  const controller = createSayController(
    enabled({ sayBudgetPerTurn: 1, sayCooldownMs: 0 }),
    { synthetic: async () => {} }
  );
  await controller.tool.execute(
    { text: 'first turn note' },
    { sessionID: 'ses_say_4', progress: async () => {} }
  );
  const blocked = await controller.tool.execute(
    { text: 'second note same turn' },
    { sessionID: 'ses_say_4', progress: async () => {} }
  );
  assert.match(blocked.content, /budget\/cooldown/);

  controller.markGuarded('ses_say_4');
  assert.equal(controller.get('ses_say_4').guarded, true);

  controller.reset('ses_say_4');
  assert.equal(controller.get('ses_say_4'), undefined);

  const afterReset = await controller.tool.execute(
    { text: 'first note of the next turn' },
    { sessionID: 'ses_say_4', progress: async () => {} }
  );
  assert.match(afterReset.content, /Noted/);
});
