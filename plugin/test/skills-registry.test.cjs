/**
 * Skill registry tiers: core skills register by default, demos only with
 * `demoSkills: true`, and `registerSkills: false` disables everything.
 */

'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(os.tmpdir(), `progress-skills-registry-test-${process.pid}`);
fs.mkdirSync(OUT, { recursive: true });
execFileSync(
  path.join(ROOT, 'node_modules', '.bin', 'esbuild'),
  [
    path.join(ROOT, 'src', 'skills.ts'),
    '--bundle',
    '--format=cjs',
    '--platform=node',
    `--define:import.meta.url=${JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'skills.ts')).href)}`,
    `--outfile=${path.join(OUT, 'skills.cjs')}`,
  ],
  { stdio: 'pipe' }
);

const {
  PACKAGED_SKILLS,
  enabledSkills,
  loadPackagedSkillBody,
  skillPath,
} = require(path.join(OUT, 'skills.cjs'));

const ids = (skills) => skills.map((skill) => skill.id);

test('default registration is the core pair only', () => {
  assert.deepEqual(ids(enabledSkills({})), ['progress-tool', 'delegation']);
  assert.deepEqual(ids(enabledSkills({ demoSkills: false })), [
    'progress-tool',
    'delegation',
  ]);
});

test('demoSkills opts the demos into the optional tier', () => {
  assert.deepEqual(ids(enabledSkills({ demoSkills: true })).sort(), [
    'delegation',
    'osc-demo',
    'progress-tool',
    'tree-demo',
  ]);
});

test('registerSkills false disables every tier', () => {
  assert.deepEqual(enabledSkills({ registerSkills: false }), []);
  assert.deepEqual(enabledSkills({ registerSkills: false, demoSkills: true }), []);
});

test('every skill maps to a real SKILL.md with a stripped body', () => {
  for (const skill of PACKAGED_SKILLS) {
    const file = skillPath(skill);
    assert.ok(fs.existsSync(file), file);
    assert.match(skill.dir, /^(skills|optional-skills)$/);
    const body = loadPackagedSkillBody(skill);
    assert.ok(body.startsWith("# [progress-tool] "), `${skill.id} body should start at the H1`);
    assert.doesNotMatch(body, /^---/);
  }
});
