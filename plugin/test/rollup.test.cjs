/**
 * Roll-up semantics for the desktop pill: done trees read 100%, while a
 * failed descendant keeps an honest partial bar.
 *
 * tree.ts is TypeScript, so transpile it to CJS with esbuild first (same
 * approach as dismissal.test.cjs). Run via: cd plugin && npm test
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-rollup-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'tree.ts'), '--bundle', '--format=cjs', `--outfile=${path.join(OUT, 'tree.cjs')}`],
  { stdio: 'pipe' }
);
const { buildTree } = require(path.join(OUT, 'tree.cjs'));

function rootOf(entries) {
  const map = {};
  for (const entry of entries) map[entry.id] = { ...entry };
  const roots = buildTree(map);
  return roots.find((node) => node.id === 'root') ?? roots[0];
}

test('a done tree rolls up to 100% even when stored child progress is partial', () => {
  const root = rootOf([
    { id: 'root', status: 'done', progress: null, title: 'Root', updatedAt: 1000 },
    { id: 'child', status: 'done', progress: 0.4, parentId: 'root', title: 'Child', updatedAt: 900 },
    { id: 'grand', status: 'done', progress: 0.7, parentId: 'child', title: 'Grand', updatedAt: 800 },
  ]);

  assert.equal(root.status, 'done');
  assert.equal(root.progress, 1, 'done root displays a full bar');
  assert.equal(root.children[0].progress, 1, 'done node also displays full');
});

test('an explicit stale parent progress cannot make a done tree read partial', () => {
  const root = rootOf([
    { id: 'root', status: 'done', progress: 0.6, title: 'Root', updatedAt: 1000 },
    { id: 'child', status: 'done', progress: 1, parentId: 'root', title: 'Child', updatedAt: 900 },
  ]);

  assert.equal(root.status, 'done');
  assert.equal(root.progress, 1);
});

test('an errored descendant overrides parent progress with the child mean', () => {
  const root = rootOf([
    // Parent was marked done (store normalizes it to 1) with a failed child.
    { id: 'root', status: 'done', progress: 1, title: 'Root', updatedAt: 1000 },
    { id: 'failed', status: 'error', progress: 0.3, parentId: 'root', title: 'Failed', updatedAt: 900 },
    { id: 'ok', status: 'done', progress: 1, parentId: 'root', title: 'OK', updatedAt: 800 },
  ]);

  assert.equal(root.status, 'error', 'root surfaces the failure');
  assert.equal(root.progress, 0.65, 'mean of child progress, not the forced parent 100%');
});

test('an error grandchild propagates its partial bar through a done child', () => {
  const root = rootOf([
    { id: 'root', status: 'done', progress: 1, title: 'Root', updatedAt: 1000 },
    { id: 'child', status: 'done', progress: 1, parentId: 'root', title: 'Child', updatedAt: 900 },
    { id: 'grand', status: 'error', progress: 0.25, parentId: 'child', title: 'Grand', updatedAt: 800 },
  ]);

  assert.equal(root.status, 'error');
  assert.equal(root.progress, 0.25);
});

test('a node that failed itself keeps its own progress when children all succeeded', () => {
  const root = rootOf([
    // The error belongs to root, not a descendant: no child-mean override.
    { id: 'root', status: 'error', progress: 0.3, title: 'Root', updatedAt: 1000 },
    { id: 'child', status: 'done', progress: 1, parentId: 'root', title: 'Child', updatedAt: 900 },
  ]);

  assert.equal(root.status, 'error');
  assert.equal(root.progress, 0.3, 'own failure progress is preserved');
});
