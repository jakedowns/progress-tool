/**
 * Skills packaging guard: the packaged copies are the canonical source for npm
 * installs, while the repo-local .opencode/skills/ copies serve in-repo
 * discovery. They must never drift.
 *
 * Two tiers ship: `skills/` (usage + delegation, registered by default) and
 * `optional-skills/` (the demos, only registered when `demoSkills` is on).
 */

'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const REPO = path.join(ROOT, '..');
const PACKAGED = path.join(ROOT, 'skills');
const OPTIONAL = path.join(ROOT, 'optional-skills');
const LOCAL = path.join(REPO, '.opencode', 'skills');

const CORE_IDS = ['progress-tool', 'delegation'];
const OPTIONAL_IDS = ['osc-demo', 'tree-demo'];

test('every packaged skill ships a SKILL.md with frontmatter', () => {
  for (const [base, ids] of [
    [PACKAGED, CORE_IDS],
    [OPTIONAL, OPTIONAL_IDS],
  ]) {
    for (const id of ids) {
      const file = path.join(base, id, 'SKILL.md');
      assert.ok(fs.existsSync(file), file);
      const raw = fs.readFileSync(file, 'utf8');
      assert.match(raw, /^---\n/, `${id} should keep frontmatter for repo discovery`);
      assert.match(raw, /^description: /m, `${id} needs a description so the model can find it`);
      assert.match(raw, /^name: \[progress-tool\] /m, `${id} should stay grouped`);
    }
  }
});

test('the demo skills are not in the default tier', () => {
  for (const id of OPTIONAL_IDS) {
    assert.ok(
      !fs.existsSync(path.join(PACKAGED, id)),
      `${id} belongs in optional-skills/, not the default skills/ dir`
    );
  }
  for (const id of CORE_IDS) {
    assert.ok(
      !fs.existsSync(path.join(OPTIONAL, id)),
      `${id} is a core skill and should stay in skills/`
    );
  }
});

test('packaged and repo-local skill copies are identical (no drift)', () => {
  for (const [base, ids] of [
    [PACKAGED, CORE_IDS],
    [OPTIONAL, OPTIONAL_IDS],
  ]) {
    for (const id of ids) {
      const packaged = fs.readFileSync(path.join(base, id, 'SKILL.md'), 'utf8');
      const local = fs.readFileSync(path.join(LOCAL, id, 'SKILL.md'), 'utf8');
      assert.equal(
        packaged,
        local,
        `${id}/SKILL.md drifted between the package and .opencode/skills`
      );
    }
  }
});

test('package.json ships both skill tiers', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.ok(pkg.files.includes('skills'), 'add "skills" to files so npm publish includes core skills');
  assert.ok(
    pkg.files.includes('optional-skills'),
    'add "optional-skills" to files so npm publish includes the demos'
  );
});
