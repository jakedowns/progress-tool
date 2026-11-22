/**
 * Subagent prompt stamping: the fallback that keeps a child's progress in the
 * parent's scope even if the session.created map write has not landed yet.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-subagent-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'subagent.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--outfile=${path.join(OUT, 'subagent.cjs')}`,
  ],
  { stdio: 'pipe' }
);

const { injectParentSession, isSubagentTool } = require(path.join(OUT, 'subagent.cjs'));

test('recognises both subagent tool ids and nothing else', () => {
  assert.equal(isSubagentTool('subagent'), true);
  assert.equal(isSubagentTool('task'), true);
  assert.equal(isSubagentTool('read'), false);
  assert.equal(isSubagentTool('shell'), false);
});

test('stamps the parent session id into the prompt without touching siblings', () => {
  const input = {
    agent: 'general',
    description: 'Check the docs',
    prompt: 'Find the answer in docs/.',
    model: 'x/y',
  };
  assert.equal(injectParentSession(input, 'ses_parent'), true);
  assert.equal(input.agent, 'general');
  assert.equal(input.description, 'Check the docs');
  assert.equal(input.model, 'x/y');
  assert.match(input.prompt, /^Find the answer in docs\/\.\n\n/);
  assert.match(input.prompt, /progress sessionId: ses_parent/);
  assert.match(input.prompt, /sessionId: "ses_parent"/);
  assert.match(input.prompt, /--session ses_parent/);
});

test('is idempotent for an already-stamped prompt', () => {
  const input = { prompt: 'Do the thing.' };
  assert.equal(injectParentSession(input, 'ses_parent'), true);
  const once = input.prompt;
  assert.equal(injectParentSession(input, 'ses_parent'), false);
  assert.equal(input.prompt, once);
});

test('ignores malformed input and missing prompts', () => {
  for (const input of [null, undefined, {}, { prompt: '' }, { prompt: 42 }, 'text']) {
    assert.equal(injectParentSession(input, 'ses_parent'), false);
  }
  assert.equal(injectParentSession({ prompt: 'x' }, ''), false);
});
