/**
 * Packaged skills and their registration tiers.
 *
 * `skills/` holds the default pair that shapes how an agent uses the tool.
 * `optional-skills/` holds the demos: they ship in the npm tarball but stay
 * unregistered unless the user sets `options.demoSkills: true`, so every
 * session is not paying description tokens for demo content.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PLUGIN_DIR = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

export type PackagedSkill = {
  id: string;
  name: string;
  description: string;
  /** Subdirectory under the package; demos live in optional-skills/. */
  dir: "skills" | "optional-skills";
  /** Only registered when options.demoSkills is true. */
  optional?: boolean;
};

export const PACKAGED_SKILLS: PackagedSkill[] = [
  {
    id: "progress-tool",
    name: "[progress-tool] Progress Tool Usage",
    dir: "skills",
    description:
      "Use the progress-tool MCP correctly — report long-horizon work (research, planning, exploration, refactors, docs) with the fire-and-forget progress tool, structure multi-step plans as a parentId tree, keep entries current between tool calls, and wrap long-running commands with the out-of-band progress-relay at zero token cost",
  },
  {
    id: "osc-demo",
    name: "[progress-tool] OSC 9;4 Demo",
    dir: "optional-skills",
    optional: true,
    description:
      "Demo OSC 9;4 terminal progress support in progress-tool — run a fake build that streams native OSC 9;4 progress sequences through the out-of-band relay (progress-relay), zero agent tokens",
  },
  {
    id: "tree-demo",
    name: "[progress-tool] Task Tree Demo",
    dir: "optional-skills",
    optional: true,
    description:
      "Demo nested task trees (parentId roll-up) in progress-tool — run a fake release pipeline with parent, child, and grandchild tasks streaming through the out-of-band relay at zero agent tokens, with an optional failure mode that rolls an error up the tree",
  },
  {
    id: "delegation",
    name: "[progress-tool] Delegation (Subagents)",
    dir: "skills",
    description:
      "Use subagents well — fan out independent research and verification in parallel, pick explore vs general, inherit the session's model, and avoid parallel-edit conflicts",
  },
];

/**
 * Which packaged skills to register.
 *
 * `registerSkills: false` disables everything; `demoSkills: true` adds the
 * optional tier. Defaults: the two core skills only.
 */
export function enabledSkills(options: {
  registerSkills?: unknown;
  demoSkills?: unknown;
}): PackagedSkill[] {
  if (options.registerSkills === false) return [];
  const demos = options.demoSkills === true;
  return PACKAGED_SKILLS.filter((skill) => !skill.optional || demos);
}

export function skillPath(skill: PackagedSkill): string {
  return path.join(PLUGIN_DIR, skill.dir, skill.id, "SKILL.md");
}

export function loadPackagedSkillBody(skill: PackagedSkill): string {
  // Strip frontmatter: the skill tool adds the Markdown body, and the
  // directory copies keep frontmatter for repo-local discovery.
  const raw = readFileSync(skillPath(skill), "utf8");
  return raw.replace(/^---\n[\s\S]*?\n---\n/, "").trimStart();
}
