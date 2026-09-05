# ADR-4030: Typed invocation context on `loop render-hooks`

- **Status:** Proposed
- **Date:** 2026-09-05
- **Issue:** #4030
- **Implementation:** Additive, optional field on the existing `loop render-hooks` CLI and JSON envelope ([ADR-857](857-capability-system.md)). No new command, dependency, or persisted state.

## Decision

`cmdLoopRenderHooks` (`src/loop-resolver.cts`) accepts one new optional flag,
`--phase <token>`, supplied by the invoking workflow at phase-scoped points
(`plan:pre`, `plan:post`, `execute:wave:pre`, `execute:wave:post`,
`verify:pre`, `verify:post`). `<token>` uses the same bare-tolerant grammar
every phase-scoped workflow already holds (`phase_number` from its own
`init.*` query — e.g. `"05"`), not the bracket display form.

The resolver does not accept a caller-supplied directory. It resolves
`phaseDir` itself by calling the already-exported `findPhaseInternal(cwd,
phase)` (`src/phase-locator.cts`) — the same function `init.*` already uses —
and surfaces both as an additive `context: { phase, phaseDir }` field, where
`phaseDir` is the literal on-disk directory name `findPhaseInternal` matched
(`toPosixPath(path.join(relBase, match))`), never a caller-supplied string.
Because the result is drawn from a `readdirSync` listing filtered by
`matchPhaseDirs`, path traversal, absolute-path substitution, and symlink
escape are structurally unreachable — there is no path string to validate,
only a directory-name match to fail loud on (mirroring `searchPhaseInDir`'s
existing #2237 ambiguous-match handling). Omitting `--phase` preserves
today's `{ point, activeHooks, rendered, warnings? }` shape exactly.

Generic `step`/`gate`/`contribution` dispatch (`gsd-core/references/loop-hook-dispatch.md`)
projects `context.phase` / `context.phaseDir` into the dispatched handler's
invocation (CLI arg, agent prompt, or command payload per handler kind).
**Invocation context is authoritative for task-local phase identity.** A
capability MUST use it over `STATE.current_phase` or artifact-order/mtime
inference when both are available — `STATE.current_phase` is project lifecycle
status, not a claim about which phase the current invocation is scoped to, and
diverges from it whenever one phase plans/verifies while another executes.

## Rationale

- **The gap is narrower than "no context exists," and that is exactly why it
  is easy to miss.** `loop-hook-dispatch.md`'s `step` → `ref.command` rule
  already does `gsd_run ${ref.command} --phase "${PHASE_NUMBER}" --raw` today
  — but `${PHASE_NUMBER}` is whatever shell variable the host workflow
  happens to hold at that call site, unvalidated and uncorrelated with the
  resolved point. `ref.skill` and `ref.agent` steps — the shape every
  first-party phase-scoped capability actually uses (e.g.
  `capabilities/pattern-mapper/capability.json`'s `plan:pre` step is
  `{"ref":{"agent":"gsd-pattern-mapper"}}`) — get no phase argument at all.
  Formalizing this as a resolver-derived, validated envelope field closes
  both gaps with one seam: it replaces the ad hoc `${PHASE_NUMBER}` handling
  for `ref.command` and adds the missing argument for `ref.skill`/`ref.agent`.
- **Rejected: doc-only convention (no code change).** Extend the
  `ref.skill`/`ref.agent` bullets in `loop-hook-dispatch.md` to instruct each
  host workflow to pass its own already-known `$PHASE`/`$PHASE_DIR` into the
  dispatched prompt/command by hand. Rejected because this is a prose
  contract every host workflow and every runtime adapter would re-derive or
  paraphrase independently — precisely the per-capability/per-adapter
  inference the issue rejects — and a non-Claude runtime adapter projecting
  the envelope onto a native hook payload has no prose to read from. A typed
  field is the only shape an adapter can project.
- **Rejected: caller-supplied `phaseDir` alongside `phase`.** An earlier draft
  of this ADR had the caller pass both `--phase` and `--phase-dir`,
  independently validated with a hand-rolled path-confinement check. Dropped
  because (a) it requires inventing new containment logic where
  `findPhaseInternal` already exists and is exported, duplicating an
  invariant this repo's own [ADR-3473](3473-enforcement-by-construction.md)
  ("one owner per invariant") argues against, and (b) it trusts the caller
  to supply a correlated pair with no cross-check, where deriving `phaseDir`
  from `phase` makes an incoherent pair structurally impossible instead of
  merely validated.
- **Evidence.** This is a property gap verified in-tree (above), not a
  single external bug report — the originating issue cites one, but that
  report cannot on its own distinguish "wrong phase received" from "hook
  mis-dispatched" (a separate, already-tracked concern in #3606/#3647), so
  it is not relied on here as the sole justification.

## Revisit if

A later ADR generalizes loop invocation context beyond `phase`/`phaseDir`
(e.g. workstream, milestone) — this ADR's `context` field would extend, not
be replaced, since the additive-envelope shape already accommodates new keys.

## References

- [ADR-857](857-capability-system.md) — capability system / loop extension points this field extends.
- [ADR-3473](3473-enforcement-by-construction.md) — "one owner per invariant"; why `phaseDir` is derived, not caller-supplied.
- `gsd-core/references/loop-hook-dispatch.md` — generic dispatch contract this ADR's `context` field extends.
- `src/phase-locator.cts`'s `findPhaseInternal` / `searchPhaseInDir` — existing phase-token-to-directory resolution this ADR reuses rather than re-implements.

## Out of scope

`gate-predicate-evaluator.cts` already accepts a `--phase-dir` value on the
unrelated `check predicate` command and does not validate it. Pre-existing,
not introduced or fixed by this ADR; left as-is.
