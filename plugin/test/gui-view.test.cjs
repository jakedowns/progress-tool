/**
 * Desktop GUI placement: composer pill vs a pinned side-region panel.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-gui-view-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'gui-view.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--outfile=${path.join(OUT, 'gui-view.cjs')}`,
  ],
  { stdio: 'pipe' }
);

const {
  GUI_PROGRESS_PANEL_ID,
  nextGuiLayout,
  normalizeGuiLayout,
  normalizeGuiSidebarWidth,
} = require(path.join(OUT, 'gui-view.cjs'));

test('layout normalizes and swaps between composer and sidebar', () => {
  assert.equal(normalizeGuiLayout('sidebar'), 'sidebar');
  assert.equal(normalizeGuiLayout('nope'), 'composer');
  assert.equal(normalizeGuiLayout(undefined), 'composer');
  assert.equal(nextGuiLayout('composer'), 'sidebar');
  assert.equal(nextGuiLayout('sidebar'), 'composer');
});

test('sidebar width defaults to 360 and clamps to 240..800', () => {
  assert.equal(normalizeGuiSidebarWidth(undefined), 360);
  assert.equal(normalizeGuiSidebarWidth('nope'), 360);
  assert.equal(normalizeGuiSidebarWidth(100), 240);
  assert.equal(normalizeGuiSidebarWidth(2000), 800);
  assert.equal(normalizeGuiSidebarWidth(420), 420);
});

test('the progress panel id is stable', () => {
  assert.equal(GUI_PROGRESS_PANEL_ID, 'progress');
});
