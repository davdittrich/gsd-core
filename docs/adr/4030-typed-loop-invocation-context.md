# ADR-4030: Typed invocation context on `loop render-hooks`

- **Status:** Proposed
- **Date:** 2026-09-05
- **Issue:** #4030
- **Implementation:** Additive, optional fields on the existing `loop render-hooks` CLI and JSON envelope ([ADR-857](857-capability-system.md)). No new command, dependency, or persisted state.

## Decision

`cmdLoopRenderHooks` (`src/loop-resolver.cts`) accepts two new optional flags,
`--phase <token>` and `--phase-dir <path>`, supplied by the invoking workflow at
phase-scoped points (`plan:pre`, `plan:post`, `execute:wave:pre`,
`execute:wave:post`, `verify:pre`, `verify:post`). When present, both are
validated — the phase token against GSD's existing phase-number grammar
(`src/phase-id.cts`), `phaseDir` confined to one direct child of the active
project's `.planning/phases` (realpath-checked, symlink-safe) — and surfaced
as an additive `context: { phase, phaseDir }` field on the envelope. Omitting
both flags preserves today's `{ point, activeHooks, rendered, warnings? }`
shape exactly.

Generic `step`/`gate`/`contribution` dispatch (`gsd-core/references/loop-hook-dispatch.md`)
projects `context.phase` / `context.phaseDir` into the dispatched handler's
invocation (CLI arg, agent prompt, or command payload per handler kind).
**Invocation context is authoritative for task-local phase identity.** A
capability MUST use it over `STATE.current_phase` or artifact-order/mtime
inference when both are available — `STATE.current_phase` is project lifecycle
status, not a claim about which phase the current invocation is scoped to, and
diverges from it whenever one phase plans/verifies while another executes.

## Rationale

- The resolver already threads an ad hoc `${PHASE_NUMBER}` into `step` →
  `ref.command` dispatch (`loop-hook-dispatch.md`); that value comes from
  whatever shell variable the host workflow happens to hold at the call site,
  unvalidated and uncorrelated with the resolved point. Making it a typed,
  validated envelope field removes the silent-wrong-phase failure mode
  (cited in #4030) without changing any non-phase-scoped caller.
- `gate-predicate-evaluator.cts` already consumes a `phaseDir` context field
  today but never validates it — this ADR's confinement check is new, not a
  fork of an existing one (none exists for this shape); it reuses the
  lexical-plus-realpath containment idiom already established in
  `src/planning-inspect.cts` (`isWithinRoot` + `fs.realpathSync`) rather than
  inventing a new one.
- Rejected alternatives (updating `STATE.current_phase` per invocation,
  mtime/artifact-order inference, capability-specific sidecars) are covered in
  the issue; each either falsifies project state or is nondeterministic under
  concurrent work.

## Revisit if

A later ADR generalizes loop invocation context beyond `phase`/`phaseDir`
(e.g. workstream, milestone) — this ADR's `context` field would extend, not
be replaced, since the additive-envelope shape already accommodates new keys.

## References

- [ADR-857](857-capability-system.md) — capability system / loop extension points this field extends.
- [ADR-2008](2008-command-exit-zero-gate.md) — generic gate-predicate evaluator; the existing unvalidated `phaseDir` consumer.
- `gsd-core/references/loop-hook-dispatch.md` — generic dispatch contract this ADR's `context` field extends.
