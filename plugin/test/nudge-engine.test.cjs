/**
 * Nudge engine default: shared is the default, legacy is an explicit opt-in,
 * and the removed shadow/comparison mode falls back to shared.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-nudge-engine-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'nudge-engine.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--outfile=${path.join(OUT, 'nudge-engine.cjs')}`,
  ],
  { stdio: 'pipe' }
);
const { resolveNudgeEngine } = require(path.join(OUT, 'nudge-engine.cjs'));

test('nudge engine: shared is the default when unset', () => {
  assert.equal(resolveNudgeEngine(undefined), 'shared');
  assert.equal(resolveNudgeEngine(null), 'shared');
  assert.equal(resolveNudgeEngine(''), 'shared');
  assert.equal(resolveNudgeEngine('shared'), 'shared');
});

test('nudge engine: legacy is an explicit opt-in', () => {
  assert.equal(resolveNudgeEngine('legacy'), 'legacy');
});

test('nudge engine: removed shadow and unknown values fall back to shared', () => {
  assert.equal(resolveNudgeEngine('shadow'), 'shared');
  assert.equal(resolveNudgeEngine('nonsense'), 'shared');
});
