/**
 * Guard: the injected rules module must parse and produce a usable string.
 *
 * This exists because an unescaped backtick inside PROGRESS_RULES (a template
 * literal) once broke the whole plugin server part at load: tool descriptions
 * stayed stale, the RPC went dark, and the GUI logged rpc timeouts.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-instructions-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'instructions.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${path.join(OUT, 'instructions.cjs')}`],
  { stdio: 'pipe' }
);
const {
  PROGRESS_RULES,
  instructionsEnabled,
  sayRules,
  sessionAttributionRules,
} = require(path.join(OUT, 'instructions.cjs'));

test('PROGRESS_RULES is a single non-empty string (no stray template delimiters)', () => {
  assert.equal(typeof PROGRESS_RULES, 'string');
  assert.ok(PROGRESS_RULES.length > 500, 'rules should be substantive');
  assert.doesNotMatch(PROGRESS_RULES, /undefined/, 'no interpolated undefined values');
});

test('rules keep the core contracts', () => {
  assert.match(PROGRESS_RULES, /DUAL PURPOSE/);
  assert.match(PROGRESS_RULES, /progress-relay/);
  assert.match(PROGRESS_RULES, /NEVER poll/);
  assert.match(PROGRESS_RULES, /Steering is work/);
  assert.match(PROGRESS_RULES, /RE-ARM/);
  assert.match(PROGRESS_RULES, /Delegate independent work/);
  assert.match(PROGRESS_RULES, /Why this tool exists/);
});

test('instructionsEnabled defaults on and can be disabled', () => {
  assert.equal(instructionsEnabled({}), true);
  assert.equal(instructionsEnabled({ injectInstructions: false }), false);
});

test('session attribution names the session and the subagent hand-off', () => {
  const text = sessionAttributionRules('ses_parent123');
  assert.match(text, /ses_parent123/);
  assert.match(text, /progress sessionId: ses_parent123/);
  assert.match(text, /sessionId: "ses_parent123"/);
  assert.match(text, /--session ses_parent123/);
  assert.match(text, /wins over the id above/);
  assert.doesNotMatch(text, /undefined/);
});

test('the delegation rule points subagents at the prompt session', () => {
  assert.match(PROGRESS_RULES, /session named in their prompt/);
  assert.match(PROGRESS_RULES, /orphaned/);
});

const sayOptions = {
  enabled: true,
  minChars: 180,
  maxChars: 260,
  budgetPerTurn: 3,
  cooldownMs: 15_000,
  chatNotes: true,
  finalGuard: true,
};

test('sayRules asks for a short intent + ETA without ending the turn', () => {
  const text = sayRules(sayOptions);
  assert.match(text, /180–260/);
  assert.match(text, /ETA/);
  assert.match(text, /does \*\*not\*\* end the turn/);
  assert.match(text, /3 notes per turn/);
  assert.match(text, /15s apart/);
  assert.ok(text.includes('`progress` is task state'));
  assert.ok(text.includes('parallel tool calls'));
  assert.doesNotMatch(text, /undefined/);
});

test('sayRules uses the resolved tool name on collision', () => {
  const text = sayRules(sayOptions, 'progress_say');
  assert.ok(text.includes('`progress_say` tool'));
  assert.ok(!text.includes('`say` tool'));
});
