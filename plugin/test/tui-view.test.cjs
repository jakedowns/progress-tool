/**
 * TUI tree budget: collapsed roots + a hard row cap, with urgency ordering.
 * The TUI renders above the prompt, so unbounded trees must never win.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-tui-view-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'tui-view.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--outfile=${path.join(OUT, 'tui-view.cjs')}`,
  ],
  { stdio: 'pipe' }
);

const { buildTuiView, sortRootsByUrgency } = require(path.join(OUT, 'tui-view.cjs'));

const root = (id, status, children = []) => ({ id, key: id, status, title: id, children });

test('roots are ordered by urgency, stable within a status', () => {
  const sorted = sortRootsByUrgency([
    root('a-done', 'done'),
    root('b-run', 'running'),
    root('c-error', 'error'),
    root('d-wait', 'waiting'),
    root('e-run', 'running'),
  ]).map((node) => node.id);
  assert.deepEqual(sorted, ['c-error', 'b-run', 'e-run', 'd-wait', 'a-done']);
});

test('collapsed roots hide their descendants and report the count', () => {
  const tree = root('build', 'running', [
    root('compile', 'done', [root('obj', 'done')]),
    root('link', 'waiting'),
  ]);
  const view = buildTuiView([tree], { maxRows: 8 });
  assert.equal(view.rows.length, 1);
  assert.equal(view.rows[0].collapsed, true);
  assert.equal(view.rows[0].hiddenChildren, 3);
  assert.equal(view.hidden, 0);
});

test('expanding a root includes descendants within the budget', () => {
  const tree = root('build', 'running', [root('compile', 'done'), root('link', 'done')]);
  const view = buildTuiView([tree], { maxRows: 8, expanded: new Set(['build']) });
  assert.deepEqual(view.rows.map((row) => row.node.id), ['build', 'compile', 'link']);
  assert.equal(view.rows[0].collapsed, false);
  assert.deepEqual(view.rows.map((row) => row.depth), [0, 1, 1]);
});

test('the row budget clips and counts what remains', () => {
  const roots = Array.from({ length: 10 }, (_, index) => root(`task-${index}`, 'running'));
  const view = buildTuiView(roots, { maxRows: 4 });
  assert.equal(view.rows.length, 4);
  assert.equal(view.hidden, 6);
});

test('expandByDefault opens roots unless the budget says otherwise', () => {
  const tree = root('build', 'running', [root('compile', 'done')]);
  const view = buildTuiView([tree], { expandByDefault: true });
  assert.deepEqual(view.rows.map((row) => row.node.id), ['build', 'compile']);
});
