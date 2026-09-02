**Step 5.5: Plan-checker loop (only when `$VALIDATE_MODE`)**

Skip this step entirely if NOT `$VALIDATE_MODE`.

Display banner:
```
### GSD ► CHECKING PLAN

◆ Spawning plan checker... (runs in a subagent — no output until it returns, ~1–5 min; expected, not a freeze)
```

Checker prompt:

```markdown
<verification_context>
**Mode:** quick-full
**Task Description:** ${DESCRIPTION}

<required_reading>
- ${QUICK_DIR}/${quick_id}-PLAN.md (Plan to verify)
</required_reading>

${AGENT_SKILLS_CHECKER}

**Scope:** This is a quick task, not a full phase. Skip checks that require a ROADMAP phase goal.
</verification_context>

<check_dimensions>
- Requirement coverage: Does the plan address the task description?
- Task completeness: Do tasks have files, action, verify, done fields?
- Key links: Are referenced files real?
- Scope sanity: Is this appropriately sized for a quick task (1-3 tasks)?
- must_haves derivation: Are must_haves traceable to the task description?

Skip: cross-plan deps (single plan), ROADMAP alignment
${DISCUSS_MODE ? '- Context compliance: Does the plan honor locked decisions from CONTEXT.md?' : '- Skip: context compliance (no CONTEXT.md)'}
</check_dimensions>

<expected_output>
- ## VERIFICATION PASSED — all checks pass
- ## ISSUES FOUND — structured issue list
</expected_output>
```

```
Agent(
  prompt=checker_prompt,
  subagent_type="gsd-plan-checker",
  model="{checker_model}",
  description="Check quick plan: ${DESCRIPTION}"
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

**Handle checker return:**

- **`## VERIFICATION PASSED`:** Display confirmation, proceed to step 6.
- **`## ISSUES FOUND`:** Count BLOCKER + WARNING entries in the YAML issues block; an entry whose severity is missing or unrecognized counts as a BLOCKER (fail closed). If zero — every entry is explicitly INFO — display `ℹ advisory — {dimension}: {description}` per entry and proceed to step 6; INFO is advisory and never enters the loop (#3724). Otherwise display issues, check iteration count, enter revision loop.

**Revision loop (max 2 iterations):**

Track `iteration_count` (starts at 1 after initial plan + check).

**If iteration_count < 2:**

Display: `Sending back to planner for revision... (iteration ${N}/2)`

Revision prompt:

Reuse the `PLAN_PRE_HOOKS_JSON` snapshot captured by Quick Step 5; do not render hooks again.

```markdown
<revision_context>
**Mode:** quick-full (revision)

<required_reading>
- ${QUICK_DIR}/${quick_id}-PLAN.md (Existing plan)
</required_reading>

${AGENT_SKILLS_PLANNER}

{For each active entry in `PLAN_PRE_HOOKS_JSON` where `kind == "contribution"` and `into == "planner"` (in array order): inject the entry's `fragment.inline` verbatim here, plus its resolved `configValues` when the entry carries them. If no active planner contributions exist, omit this block entirely.}

**Checker issues:** ${structured_issues_from_checker}

</revision_context>

<instructions>
Make targeted updates to address checker issues.

`required_property` + evidence + severity BIND. `fix_hint` is ONE non-binding example route: a
smaller or different mechanism reaching the same property addresses the issue in full — say which
you used. Re-check ${DISCUSS_MODE ? 'locked decisions in ' + quick_id + '-CONTEXT.md, ' : ''}capability guidance (CLAUDE.md, project skills) and the
constraints these plans already encode BEFORE editing; if a hint would contradict one, or the
property is unreachable without breaking one, return `## REVISION_CONFLICT` with the conflict and
the alternatives rather than applying or working around it. Full contract:
`gsd-core/references/planner-revision.md`, which you load in revision mode.

Do NOT replan from scratch unless issues are fundamental.
Return what changed.
</instructions>
```

```
Agent(
  prompt=revision_prompt,
  subagent_type="gsd-planner",
  model="{planner_model}",
  description="Revise quick plan: ${DESCRIPTION}"
)
```

> **ORCHESTRATOR RULE — CODEX RUNTIME**: After calling Agent() above, stop working on this task immediately. Do not read more files, edit code, or run tests related to this task while the subagent is active. Wait for the subagent to return its result. This prevents duplicate work, conflicting edits, and wasted context. Only resume when the subagent result is available.

**On `## REVISION_CONFLICT`:** do NOT increment `iteration_count` or check. Present alternatives to the user; ask them to adopt a named alternative, override the named constraint and apply the hint, or amend the constraint; accepting the blocker is NOT offered here. Derive sorted unique `(issue_identity, required_property)` keys. Any canonical conflict key repeated in consecutive returns, or the THIRD conflict return, escalates as a stall. Percent-encode each nonempty UTF-8 field per RFC 3986 (only unreserved bytes remain). Re-spawn with `{issue_identity} | required_property: {property} | chosen_resolution: {chosen_resolution}` triples and re-evaluate its return from the top of this handler. Quick has no persistence channel.

**Only on `## REVISION COMPLETE`:** require `### Applied Conflict Resolutions` to acknowledge every exact `issue_identity | required_property: property | chosen_resolution: chosen_resolution` triple supplied in the re-spawn prompt. If any triple is absent or mismatched, treat the return as unknown: offer Retry or Stop; do not check or increment. On a qualifying return after exact acknowledgement, spawn checker, then increment `iteration_count`.

**Otherwise (unknown, empty, or both markers):** offer Retry or Stop. Do not check or increment.

**If iteration_count >= 2:**

Display: `Max iterations reached. ${N} issues remain:` + issue list

Offer: 1) Force proceed, 2) Abort
