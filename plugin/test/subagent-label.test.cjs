/**
 * Pill root label for subagent-authored work: `[Subagent (Explore)]: Title`.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-subagent-label-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'tree.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--outfile=${path.join(OUT, 'tree.cjs')}`,
  ],
  { stdio: 'pipe' }
);

const { subagentPrefix, subagentTypeLabel, truncatedSubagentName } = require(path.join(OUT, 'tree.cjs'));

test('plain entries get no prefix', () => {
  assert.equal(subagentPrefix({ title: 'Build', status: 'running' }), '');
  assert.equal(subagentPrefix({ title: 'Build', status: 'running', subagent: false }), '');
});

test('subagent entries use the session name, not the type', () => {
  assert.equal(subagentPrefix({ title: 'x', status: 'running', subagent: true }), '[subagent]: ');
  assert.equal(
    subagentPrefix({ title: 'x', status: 'running', subagent: true, subagentAgent: 'explore' }),
    '[subagent]: ',
    'type stays out of the prefix'
  );
  assert.equal(
    subagentPrefix({
      title: 'x',
      status: 'running',
      subagent: true,
      subagentAgent: 'explore',
      subagentName: 'Review docs',
    }),
    '[subagent Review docs]: '
  );
  assert.equal(
    subagentPrefix({
      title: 'x',
      status: 'running',
      subagent: true,
      subagentName: '  1234567890123456789012345  ',
    }),
    '[subagent 1234567890123456789…]: ',
    'name truncated to 20 characters'
  );
  assert.equal(subagentTypeLabel({ title: 'x', status: 'running', subagent: true, subagentAgent: 'explore' }), 'Explore');
  assert.equal(subagentTypeLabel({ title: 'x', status: 'running' }), '');
  assert.equal(truncatedSubagentName('  spaced   name '), 'spaced name');
});
