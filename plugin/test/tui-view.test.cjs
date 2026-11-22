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

const {
  buildTuiView,
  nextTuiLayout,
  normalizeMaxRoots,
  normalizeSidebarRows,
  normalizeTuiLayout,
  rootDetailLines,
  sortRootsByUrgency,
  summarizeRoots,
} = require(path.join(OUT, 'tui-view.cjs'));

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

test('the root cap hides extra roots after urgency ordering', () => {
  const roots = [
    root('a-done', 'done'),
    root('b-run', 'running'),
    root('c-error', 'error'),
    root('d-wait', 'waiting'),
    root('e-done', 'done'),
  ];
  const view = buildTuiView(roots, { maxRows: 8, maxRoots: 3 });
  assert.deepEqual(
    view.rows.map((row) => row.node.id),
    ['c-error', 'b-run', 'd-wait']
  );
  assert.equal(view.hidden, 0);
  assert.equal(view.hiddenRoots, 2);
});

test('root detail shows the full untruncated description', () => {
  const long = `start ${'detail '.repeat(40)}end`;
  const node = {
    ...root('build', 'running', [root('child', 'done')]),
    detail: long,
    progress: 0.5,
  };
  const lines = rootDetailLines(node);
  assert.ok(lines.includes('status: running'));
  assert.ok(lines.includes('progress: 50%'));
  assert.ok(lines.includes('descendants: 1'));
  assert.ok(lines.includes(long), 'description must not be truncated');
});

test('clipRows false hands the full view to an external scrollbox', () => {
  const roots = Array.from({ length: 4 }, (_, index) => root(`task-${index}`, 'running'));
  const view = buildTuiView(roots, { maxRows: 2, maxRoots: 3, clipRows: false });
  assert.equal(view.rows.length, 3);
  assert.equal(view.hidden, 0);
  assert.equal(view.hiddenRoots, 1);
});

test('normalizeMaxRoots clamps to 1..50 with a 3 default', () => {
  assert.equal(normalizeMaxRoots(undefined), 3);
  assert.equal(normalizeMaxRoots('nope'), 3);
  assert.equal(normalizeMaxRoots(0), 1);
  assert.equal(normalizeMaxRoots(100), 50);
  assert.equal(normalizeMaxRoots(5), 5);
});

test('layout normalizes and swaps between composer and sidebar', () => {
  assert.equal(normalizeTuiLayout('sidebar'), 'sidebar');
  assert.equal(normalizeTuiLayout('nope'), 'composer');
  assert.equal(normalizeTuiLayout(undefined), 'composer');
  assert.equal(nextTuiLayout('composer'), 'sidebar');
  assert.equal(nextTuiLayout('sidebar'), 'composer');
});

test('normalizeSidebarRows defaults to 0 (full tree) and clamps to 0..100', () => {
  assert.equal(normalizeSidebarRows(undefined), 0);
  assert.equal(normalizeSidebarRows(0), 0);
  assert.equal(normalizeSidebarRows(200), 100);
  assert.equal(normalizeSidebarRows(30), 30);
});

test('collapsed summary counts statuses separately from dismissed roots', () => {
  const roots = [
    root('w', 'waiting'),
    root('r1', 'running'),
    root('r2', 'running'),
    root('r3', 'running'),
    root('e1', 'error'),
    root('e2', 'error'),
    root('d1', 'done'),
    root('d2', 'done'),
    root('d3', 'done'),
    root('d4', 'done'),
    root('d5', 'done'),
    root('x1', 'done'),
    root('x2', 'error'),
    root('x3', 'waiting'),
  ];
  const dismissed = new Set(['x1', 'x2', 'x3']);
  assert.equal(
    summarizeRoots(roots, (node) => dismissed.has(node.id)),
    'waiting (1) | running (3) | error (2) | done (5) | dismissed (3)'
  );
});

test('collapsed summary omits zero buckets and empty trees', () => {
  assert.equal(summarizeRoots([root('r', 'running')], () => false), 'running (1)');
  assert.equal(summarizeRoots([], () => false), '');
});

test('expandByDefault opens roots unless the budget says otherwise', () => {
  const tree = root('build', 'running', [root('compile', 'done')]);
  const view = buildTuiView([tree], { expandByDefault: true });
  assert.deepEqual(view.rows.map((row) => row.node.id), ['build', 'compile']);
});
