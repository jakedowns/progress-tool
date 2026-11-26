# Nudge migration TODO

**Status:** Phase 0 scaffolded; policy extraction not started  
**Target:** extract nudges into shared packages so progress, say, voice, and future tools use one policy engine.  
**Full design:** `/home/ubuntu/.opencode/plan/shared-nudges.md` (shared design notes)  
**Current plugin:** `2.27.0` on `feat/nudge-redesign`

> **PUBLISHING HOLD (2026-11-26):** do not `git push`, tag, or `npm publish`
> anything for this migration. The maintainer will confirm when to publish.
> Local files only until then.

## Phase 0 status (2026-11-26)

- [x] `NudgeCandidate`, gate result, rule/config/state types.
- [x] Adapter surface (`NudgeHost`, `NudgeAdapter`) with no OpenCode imports.
- [x] Baseline fixture for current progress/say thresholds and messages.
- [x] Contract doc (`opencode-helpers/docs/contract.md`).
- [x] Workspace scaffold at `/media/share/opencode-helpers` (packages/core/adapter).
- [ ] Monorepo `git init` / first commit (held).
- [ ] Install dev deps + typecheck/build (held with publishing).
- [ ] Phase 1 extraction.

---

## Locked decisions

- [x] Distribution: pure **`nudge-core`** + host **`nudge-opencode`** npm packages.
- [x] Agent surface: one shared **`nudge`** tool (first loaded adapter registers it; later copies skip).
- [x] Config: unified global/project **`nudge.json`**; legacy progress options/rules mapped once.
- [x] Host context key: rename `progress-reminder` → **`nudge`** with a migration shim.
- [x] Repo layout: new monorepo **`/media/share/opencode-helpers`** with
      `packages/nudge-core` + `packages/nudge-opencode`.

---

## 1. Monorepo bootstrap

- [ ] `git init /media/share/opencode-helpers` (held)
- [x] npm workspaces root (`package.json`, `tsconfig.base.json`)
- [x] `packages/nudge-core` — `@jakedowns/opencode-nudge-core@0.1.0`
- [x] `packages/nudge-opencode` — `@jakedowns/opencode-nudge@0.1.0`
- [ ] ESM + TypeScript strict, `node:test`, `npm test` at root
- [ ] Publish workflow keyed by `nudge-core@x.y.z` / `nudge-opencode@x.y.z`
- [ ] README with install + producer contract

## 2. Core extraction

- [x] Define `NudgeCandidate`, `NudgeGateResult`, rule schema, config normalizer.
- [x] Move/port from `plugin/src/reminders.ts`:
      severity, hash/dedupe, age formatting, gap/grace helpers.
- [x] Move/port policy from `plugin/src/monitor.ts`:
      strict/wall/idle criteria, thresholds, escalation.
- [x] Move/port from `plugin/src/say-monitor.ts`:
      trigger/cooldown/cap decisions.
- [x] Move/port from `plugin/src/custom-nudges.ts`:
      rule store, merge/tombstones, matcher, scheduler, placeholders.
- [x] Split filesystem stores out of `custom-nudges.ts` into `custom-nudge-store.ts`.
- [ ] Inject the store into the adapter so policy never imports `node:fs`.
- [x] Move tests with golden message texts and fake clocks.
- [x] Golden-test current progress/say behavior before changing call sites.
      (74 passed against extracted core)

> **Phase 1 note:** product message builders are temporarily colocated in core
> for parity. Move them back to producer modules when the adapter is wired.
> `custom-nudges.ts` is pure; `custom-nudge-store.ts` owns `node:fs` and will be
> injected into the adapter in Phase 2.

## 3. Host adapter

- [x] `createNudgeAdapter(host, options)` with `submit`, `clear`, `touch`, `mute`, `status`.
- [x] Shared runtime file: `~/.config/opencode/nudge-state.json`
      (atomic temp+rename + sibling lock).
- [x] One standing key **`nudge`**; migrate/remove `progress-reminder` once per session.
- [ ] One timer for scheduled rules; prompt reset; idle flush.
- [x] Delivery: context entry; synthetic only for `block`.
- [x] One generic `nudge` tool definition: `status|mute|unmute|clear`.
- [ ] Register it from the host adapter (first loader wins).
- [ ] Registration race: if `nudge` is taken, later adapter copies skip the tool but still share state.
- [x] Basic telemetry: fired/deduped/muted/gap/grace/cap with producer + rule id.
- [x] Single-process conformance test: one gate, one key, priority/gap/grace/cap.
- [ ] Cross-process concurrency stress test.

## 4. Config + migration

- [x] `~/.config/opencode/nudge.json`, `<project>/.opencode/nudge.json`
- [ ] Session rules in the existing session store.
- [x] Read legacy `progress-nudge.json` as fallback when `nudge.json` is absent.
- [ ] Write migrated legacy rules forward to `nudge.json` (optional).
- [ ] Map `strictMode`, `sayNudge*`, `nudgeGapMs`, `nudgeGraceMs`,
      `customNudges` into producer config; do not import them into core.
- [ ] Document schema + examples.
- [ ] Migration test: old config/rules still produce the same behavior.

## 5. Progress/say refactor

- [ ] Replace `putReminder`, `lastReminderAt`, mute/gap/grace/cap, delivery and
      `progress_nudge` plumbing with adapter calls.
- [ ] Keep progress signal detection and message builders.
- [ ] Submit candidates:
      `progress.tree` (strict/wall), `progress.idle`, `progress.relay`,
      `say`, custom rules.
- [ ] Move `progress_nudge` behind the shared `nudge` tool (alias for one release).
- [ ] Delete duplicated policy modules after regression tests pass.
- [ ] Keep existing behavior behind feature flag `nudgeEngine: "shared"|"legacy"`
      for one release.

## 6. Voice integration

- [ ] Add `/media/share/opencode-audio-tool` as a consumer of `@jakedowns/opencode-nudge`.
- [ ] Voice signal(s): e.g. long spoken reply not delivered, voice tool unused when requested.
- [ ] Config: `voiceNudge` threshold/cooldown/severity.
- [ ] No delivery code in voice; only `adapter.submit(...)`.

## 7. Wording variation (anti-repetition)

**Requirement:** future models should not see the exact same reminder sentence every time.
Use **non-token, constant-list remixing** — no LLM call, no per-fire token cost.

- [ ] Core template model:
      a nudge supplies an array of **template variants** plus optional word pools.
      ```ts
      {
        templates: [
          "{target} has been {status} for {age}. {action}.",
          "{target} is still {status} ({age}). {action}.",
          "No update on {target} for {age}. {action}."
        ],
        leads: ["Heads-up:", "Reminder:", ""],
        actions: ["Update detail/progress or close it.", "Close it or refresh the detail."]
      }
      ```
- [ ] Deterministic rotation (no PRNG dependency):
      index = hash(`sessionID|producer|ruleId|target|fireCount|dayBucket`) % variants.length.
      Same session does not flip on every render; different sessions/rules do.
- [ ] Avoid immediate repeats: remember `lastTemplate` per producer/rule and pick the
      next index if it collides (basic index+1 fallback).
- [ ] Preserve semantics: same target, severity, and action; vary only connective text,
      lead-ins, and verb order. Never vary the required action away.
- [ ] Keep the severity prefix fixed (`[info]`/`[warn]`/`[block]`).
- [ ] Length cap (240 chars) applied after remixing.
- [ ] Config: `wordingVariation: "off" | "low" | "high"` (default `low`).
      `off` uses variant 0 only.
- [ ] Tests:
      - variants render the same placeholders safely
      - no immediate duplicate template
      - deterministic for a fixed hash input
      - `off` is byte-stable
      - custom rules can use `templates[]`; legacy `text` becomes a one-item list.
- [ ] Document that variation is local text remixing only; no model/token use.

## 8. Hypothesis: synthetic user-message injection

**Hypothesis.** A nudge delivered as a **synthetic user message** (a real turn input)
produces higher follow-through than the same nudge as a context entry, because
context blocks are skimmable and do not interrupt the model's current plan.

**Why test it now.** The current engine reserves synthetic delivery for `block`.
If context entries are the main reason agents ignore `warn` nudges, moving more
nudges to synthetic delivery could improve compliance more than threshold tuning.
The cost is extra turns/tokens and visible interruption, so this must be measured,
not assumed.

### Experiment shape

- Add a delivery policy flag per producer/rule:
  `nudgeDelivery: "context" | "synthetic" | "escalate"`.
  - `context`: current behavior
  - `synthetic`: every eligible fire is a synthetic user message
  - `escalate`: first N fires context, then one synthetic
- Run as a plugin option/feature flag, default `context` until proven.
- Compare in dogfood sessions and, if possible, an A/B split by session.
- Keep the wording identical across arms so delivery is the only variable.

### Matrix

| Arm | `info` | `warn` | `block` |
|---|---|---|---|
| A | context | context | synthetic |
| B | context | synthetic | synthetic |
| C | synthetic | synthetic | synthetic |

Run each arm with the same gap/grace/cap. Test at least one long authoring
session and one tree-heavy implementation session per arm.

### Guardrails while testing

- Never inject while a tool is in flight; queue to the next step.
- Respect session mute and `nudgeGapMs`; synthetic does not bypass mute.
- At most **one synthetic nudge per 10 minutes per session** initially.
- One synthetic per rule without an intervening state change.
- Stop the experiment if synthetic nudges create reply loops, unexplained
  extra turns, or repeated identical user messages.
- Keep the `nudge` tool's `mute` visible so an agent can opt out.

### Metrics

- **Primary:** did a progress/voice/say write follow within **1 turn**?
- Time from nudge to write.
- Fires per session and synthetic share.
- Extra turns/tokens attributable to the synthetic message.
- User-visible interruptions (synthetics per hour).
- Mute usage and rule disable rate.
- False positives: nudge fired but no valid action existed.
- Post-nudge tree accuracy (stale entries closed vs ignored).

### Falsification

Reject or narrow the hypothesis if:

- synthetic delivery improves compliance by less than ~15–20 percentage points;
- extra turns/tokens outweigh the gain;
- synthetic nudges cause reply loops or repeated restatements;
- compliance gains only come from `block`-level urgency, meaning context is
  fine for `warn`.

### Implementation notes

- Adapter already has both delivery paths; expose the policy in the shared
  `nudge` config and telemetry.
- Record `delivery` on every fire so compliance can be compared.
- Ensure a synthetic nudge does not reset the prompt-time counters in a way
  that grants another full nudge budget; prompt-vs-synthetic must be
  distinguishable in the host hooks.
- Wording variation applies to both arms; the only difference is channel.

### Decision gate

Before flipping a default:

- one clean dogfood week with arm B or C;
- primary metric improvement without loop/extra-turn regressions;
- a documented rollback (`nudgeDelivery: "context"`).

## 9. Rollout

- [ ] Publish `nudge-core` → `nudge-opencode` → progress `2.28.0` → voice.
- [ ] Feature flag default off; flip after regression + a dogfood session.
- [ ] Remove legacy modules in the next major.
- [ ] Update changelog, README-advanced, plugin README, voice docs.
- [ ] Tag/publish only after a clean release-bundle `-dev` check.

## 10. Notes to test later

### 10.1 Nudge the agent to `list` first, then trim done trees

**Idea.** Instead of only saying "update the tree", nudge the agent to **call the
`list` tool first**, inspect the current tree, and then act. Make the default
`list` response drop or aggressively summarize **done trees**, so the agent
focuses on stalled / queued / running work.

**Hypothesis.** A list-first workflow reduces blind writes and stale parents:
the agent sees the real shape before deciding what to update or close. Hiding
completed trees reduces response size and attention dilution.

**Tradeoff to watch.** If done trees disappear from `list`, agents may stop
reusing or reviving roots that should be reopened. A completed root is also
useful evidence that a workstream already exists.

**Experiment options**

- `list.includeTerminal` default `false` (currently `true`), with a trailing
  `N done hidden — pass includeTerminal:true` line.
- Or keep done roots but collapse them to one summary row per tree:
  `done: prior-art (12 children)`.
- Nudge copy: "Run list first; then update stalled/queued entries. Done trees
  are hidden unless you ask."
- Variant: only include **recent** done trees (e.g. last 30m) and summarize
  older ones.

**Signals to measure**

- list calls followed by a progress write within 1 turn;
- reduction in stale `running` parents;
- reduction in duplicate roots;
- revival of done roots (should not go to zero);
- response tokens/latency for `list`;
- agent follow-up requests for `includeTerminal:true`.

**Do not implement yet.** Record the tradeoff and test after the shared nudge
adapter exists, so delivery and wording can be measured independently.

### 10.2 Config: prefer root reuse vs episodic root genesis

**Idea.** Add a config option such as:

```json
{ "rootPolicy": "reuse" | "episodic" | "auto" }
```

- `reuse`: keep one root per workstream/feature and nest phases under it.
- `episodic`: start a new root for each long-running phase or work session,
  connecting it to the previous root in `detail` (no new schema required yet).
- `auto`: reuse while the root is still running/recent; start a new root when
  the previous root is `done`, cold (untouched for N hours), or the user’s
  intent clearly changed.

**Why.** Long-running work can become one enormous root that is hard to scan,
or a pile of duplicate roots that fragment history. The right default probably
depends on work type: a build/debug thread wants continuity; a multi-week
research program wants episodic chapters.

**Interactions**

- Pairs with `list.includeTerminal`: episodic mode needs enough recent done
  roots visible to link the next chapter.
- Interacts with dismissal/revival: a done root hidden from `list` is less
  likely to be revived.
- Nudge copy should say which policy is active, e.g. “reuse `feature-auth`” vs
  “start `feature-auth-2` linked to the previous root”.
- Do not add a schema field yet; first test `detail` linkage. If it works,
  consider a real `continuesFrom`/`rootGroup` field later.

**Metrics**

- roots per workstream and duplicate-root rate;
- average root size/depth and list response size;
- done-root revival rate;
- time for a new agent to understand the current state from `list`;
- user-visible clarity in the pill.

**Do not implement yet.** Decide after the shared adapter + list-first experiment;
root policy should be core policy, not a progress-only option.

## Acceptance

- [ ] A new tool adds a nudge with only a signal + config mapping.
- [ ] Progress/say behavior matches the golden tests.
- [ ] One reminder per session across producers, one mute, one `nudge` key.
- [ ] No producer imports `monitor.ts`, `reminders.ts`, `say-monitor.ts`, or
      `custom-nudges.ts` directly.
- [ ] Repeated nudges do not reuse the same sentence back-to-back.
