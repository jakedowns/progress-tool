/**
 * Skills packaging guard: the packaged copies (plugin/skills/) are the
 * canonical source for npm installs, while the repo-local .opencode/skills/
 * copies serve in-repo discovery. They must never drift.
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const PACKAGED = path.join(ROOT, 'skills');
const LOCAL = path.join(REPO, '.opencode', 'skills');

const IDS = ['progress-tool', 'osc-demo', 'tree-demo', 'delegation'];

test('every packaged skill ships a SKILL.md with frontmatter', () => {
  for (const id of IDS) {
    const file = path.join(PACKAGED, id, 'SKILL.md');
    assert.ok(fs.existsSync(file), file);
    const raw = fs.readFileSync(file, 'utf8');
    assert.match(raw, /^---\n/, `${id} should keep frontmatter for repo discovery`);
    assert.match(raw, /^description: /m, `${id} needs a description so the model can find it`);
  }
});

test('packaged and repo-local skill copies are identical (no drift)', () => {
  for (const id of IDS) {
    const packaged = fs.readFileSync(path.join(PACKAGED, id, 'SKILL.md'), 'utf8');
    const local = fs.readFileSync(path.join(LOCAL, id, 'SKILL.md'), 'utf8');
    assert.equal(packaged, local, `${id}/SKILL.md drifted between plugin/skills and .opencode/skills`);
  }
});

test('package.json ships the skills directory', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('skills'), 'add "skills" to files so npm publish includes them');
});
