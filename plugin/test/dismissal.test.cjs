/**
 * Dismissal semantics tests for the desktop pill's shared tree helpers.
 *
 * tree.ts is TypeScript, so these tests transpile it to CJS with esbuild
 * (already present in plugin/node_modules) before requiring it. Run via:
 *
 *   cd plugin && npm test
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-tree-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'tree.ts'), '--bundle', '--format=cjs', `--outfile=${path.join(OUT, 'tree.cjs')}`],
  { stdio: 'pipe' }
);
const { buildTree, isDismissed, dismissalsFor } = require(path.join(OUT, 'tree.cjs'));
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [path.join(ROOT, 'src', 'state.ts'), '--bundle', '--format=cjs', '--platform=node', `--outfile=${path.join(OUT, 'state.cjs')}`],
  { stdio: 'pipe' }
);
const { writeDismissal } = require(path.join(OUT, 'state.cjs'));

/** buildTree sorts by severity/updatedAt; pick the root by id, not position. */
function makeTreeFind(entries) {
  const roots = makeTree(entries);
  return [roots.find((n) => n.id === 'root') ?? roots[0], roots];
}

function makeTree(entries) {
  const map = {};
  for (const e of entries) map[e.id] = { ...e };
  return buildTree(map);
}

const ROOT_ENTRY = (over = {}) => ({
  id: 'root',
  status: 'running',
  title: 'Root',
  updatedAt: 1000,
  ...over,
});

test('non-terminal dismissal: sibling activity never revives; self re-report revives', () => {
  const [root] = makeTreeFind([ROOT_ENTRY()]);
  const dismissed = dismissalsFor([root], {});
  assert.equal(isDismissed(root, dismissed), true);

  // Sibling root touched/appended: the dismissed root's own signals unchanged.
  const [rootStill] = makeTreeFind([ROOT_ENTRY({ updatedAt: 1000 }), { id: 'sib', status: 'running', title: 'Sib', updatedAt: 5000 }]);
  assert.equal(isDismissed(rootStill, dismissed), true);

  // Agent re-reports the dismissed id: reportedAt bumps → revives.
  const [rootRevived] = makeTreeFind([ROOT_ENTRY({ updatedAt: 9000 })]);
  assert.equal(isDismissed(rootRevived, dismissed), false);
});

test('non-terminal dismissal: rolled-up status change revives', () => {
  const [root] = makeTreeFind([
    ROOT_ENTRY(),
    { id: 'child', status: 'running', title: 'Child', parentId: 'root', updatedAt: 1000 },
  ]);
  const dismissed = dismissalsFor([root], {});
  assert.equal(isDismissed(root, dismissed), true);

  const [rootAfter] = makeTreeFind([
    ROOT_ENTRY({ updatedAt: 1000 }),
    { id: 'child', status: 'error', title: 'Child', parentId: 'root', updatedAt: 6000 },
  ]);
  assert.equal(isDismissed(rootAfter, dismissed), false, 'child error flips rolled-up status → revive');
});

test('terminal (done) dismissal: appended child flipping done→running does NOT revive', () => {
  // This is the reported bug: agent calls progress for a child (parentId =
  // done root) or a sibling; the dismissed done root must stay hidden.
  const [root] = makeTreeFind([
    ROOT_ENTRY({ status: 'done', updatedAt: 1000 }),
    { id: 'child', status: 'done', title: 'Child', updatedAt: 1000 },
  ]);
  const dismissed = dismissalsFor([root], {});

  // Sibling root appended/touched.
  const [withSibling] = makeTreeFind([
    ROOT_ENTRY({ status: 'done', updatedAt: 1000 }),
    { id: 'child', status: 'done', title: 'Child', updatedAt: 1000 },
    { id: 'sib', status: 'running', title: 'New', updatedAt: 9000 },
  ]);
  assert.equal(isDismissed(withSibling, dismissed), true, 'sibling activity must not revive a dismissed done root');

  // New child appended under the done root flips rolled-up done→running.
  const [withNewChild] = makeTreeFind([
    ROOT_ENTRY({ status: 'done', updatedAt: 1000 }),
    { id: 'child', status: 'done', title: 'Child', updatedAt: 1000 },
    { id: 'child2', status: 'running', title: 'New child', parentId: 'root', updatedAt: 9000 },
  ]);
  assert.equal(isDismissed(withNewChild, dismissed), true, 'appended child must not revive a dismissed done root');
});

test('terminal (done) dismissal: a child FAILING still revives (failure cannot scroll away)', () => {
  const [root] = makeTreeFind([
    ROOT_ENTRY({ status: 'done', updatedAt: 1000 }),
    { id: 'child', status: 'done', title: 'Child', parentId: 'root', updatedAt: 1000 },
  ]);
  const dismissed = dismissalsFor([root], {});

  const [failed] = makeTreeFind([
    ROOT_ENTRY({ status: 'done', updatedAt: 1000 }),
    { id: 'child', status: 'error', title: 'Child', parentId: 'root', updatedAt: 9000 },
  ]);
  assert.equal(isDismissed(failed, dismissed), false, 'rolled-up error revives a done-dismissed tree');
});

test('terminal (done) dismissal: direct re-report of the root id revives (lifecycle restart)', () => {
  const [root] = makeTreeFind([ROOT_ENTRY({ status: 'done', updatedAt: 1000 })]);
  const dismissed = dismissalsFor([root], {});

  const [restarted] = makeTreeFind([ROOT_ENTRY({ status: 'running', updatedAt: 9000 })]);
  assert.equal(isDismissed(restarted, dismissed), false, 're-reported id revives even when terminal-dismissed');
});

test('error dismissal: only a direct re-report revives; failures elsewhere do not', () => {
  const [root] = makeTreeFind([ROOT_ENTRY({ status: 'error', updatedAt: 1000 })]);
  const dismissed = dismissalsFor([root], {});

  assert.equal(isDismissed(makeTree([ROOT_ENTRY({ status: 'error', updatedAt: 1000 })])[0], dismissed), true);
  assert.equal(isDismissed(makeTree([ROOT_ENTRY({ status: 'error', updatedAt: 9000 })])[0], dismissed), false);
});

test('buildTree carries the persisted dismissed field through to nodes', () => {
  const [root] = makeTreeFind([ROOT_ENTRY({ dismissed: { status: 'running', at: 42 } })]);
  assert.deepEqual(root.dismissed, { status: 'running', at: 42 });
});

test('writeDismissal persists {status, at} atomically and cleans up its lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'progress-dismiss-'));
  const file = path.join(dir, 'state.json');
  process.env.PROGRESS_STATE_PATH = file;
  fs.writeFileSync(
    file,
    JSON.stringify({ entries: { 'sess-1:root': { id: 'root', status: 'running', title: 'R', updatedAt: 1000 } }, version: 2 })
  );

  assert.equal(writeDismissal('sess-1:root', 'running'), true);
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entry = Object.values(state.entries)[0];
  assert.equal(entry.dismissed.status, 'running');
  assert.equal(typeof entry.dismissed.at, 'number');
  assert.ok(entry.dismissed.at >= 1000);
  assert.equal(fs.existsSync(`${file}.lock`), false, 'lock released');

  // Unknown key: no-op, still clean.
  assert.equal(writeDismissal('missing-key', 'running'), false);
  assert.equal(fs.existsSync(`${file}.lock`), false);
});
