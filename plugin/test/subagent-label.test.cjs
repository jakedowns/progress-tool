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

const { subagentPrefix } = require(path.join(OUT, 'tree.cjs'));

test('plain entries get no prefix', () => {
  assert.equal(subagentPrefix({ title: 'Build', status: 'running' }), '');
  assert.equal(subagentPrefix({ title: 'Build', status: 'running', subagent: false }), '');
});

test('subagent entries are flagged, with the agent type when known', () => {
  assert.equal(subagentPrefix({ title: 'x', status: 'running', subagent: true }), '[Subagent]: ');
  assert.equal(
    subagentPrefix({ title: 'x', status: 'running', subagent: true, subagentAgent: 'explore' }),
    '[Subagent (Explore)]: '
  );
  assert.equal(
    subagentPrefix({ title: 'x', status: 'running', subagent: true, subagentAgent: 'general' }),
    '[Subagent (General)]: '
  );
  assert.equal(
    subagentPrefix({ title: 'x', status: 'running', subagent: true, subagentAgent: '  ' }),
    '[Subagent]: '
  );
});
