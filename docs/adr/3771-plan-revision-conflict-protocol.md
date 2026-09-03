# ADR-3771: Plan-revision conflicts use one owned review slot and canonical field transport

| | |
|---|---|
| **Status** | Proposed |
| **Date** | 2026-09-03 |
| **Issue** | [#3771](https://github.com/open-gsd/gsd-core/issues/3771) |
| **Pull request** | [#3916](https://github.com/open-gsd/gsd-core/pull/3916) |
| **Amends** | — |
| **Supersedes** | — |

## Context

Checker findings contain a binding `required_property` and a non-binding
`fix_hint`. A planner can satisfy the property by a smaller or different
mechanism. If active constraints make the property unreachable, however, the
revision loop needs user arbitration without consuming revision budget or
silently losing the blocker.

The protocol crosses five prompt producers, the shared revision-loop
reference, the plan-review artifact writer, and the convergence reader.
Without an explicit ownership and encoding decision, three failures are
possible:

1. reviewer prose can forge live conflict state;
2. delimiter-bearing agent text can change record identity or structure; and
3. a resumed reviews-mode plan can drop the user's chosen resolution or close
   the record before the producer acknowledges applying it.

## Decision

### 1. The property, not the hint, controls conflict routing

When a `fix_hint` conflicts with an active constraint, the producer first
tries the smallest constraint-compatible mechanism that satisfies
`required_property`. It returns `REVISION_CONFLICT` only when no such
mechanism can satisfy the property.

Conflict returns do not consume revision iterations. Each return is validated
and idempotently persisted before either bound is evaluated, so the terminal
third return remains visible. Consecutive repetition of the same canonical
conflict key stalls immediately; the third conflict return stalls regardless of
key, preventing alternating conflicts from making the loop unbounded.

### 2. One fixed slot in the existing review artifact owns persisted state

`REVIEWS.md` contains one writer-owned slot at the first nonblank line after its title:

```markdown
<!-- gsd:plan-revision-conflicts:begin -->
## Plan-Revision Conflicts
- [ ] REVISION_CONFLICT {fields}
<!-- gsd:plan-revision-conflicts:end -->
```

Only `plan-phase` mutates this slot. Reviewer output is outside it and is
never state. Missing, duplicated, nested, unreadable, or malformed ownership
markers fail the convergence gate closed.

### 3. Producers own initial encoding; consumers preserve encoded identity

Every returned conflict field is a nonempty canonical UTF-8 percent-encoded
token: RFC 3986 unreserved bytes remain literal and every other byte uses an
uppercase `%HH` escape.

The producer encodes raw `issue_identity`, `required_property`,
`conflicts_with`, and `alternatives` once. Consumers strict-decode and
byte-wise re-encode to validate canonical form, but keep the original encoded
tokens authoritative for keys, persistence, and prompt transport. Decoded
copies are display-only. A consumer encodes the user's raw
`chosen_resolution` once.

### 4. Closure requires explicit producer acknowledgement

A user choice leaves the persisted record open while its exact
`issue_identity | required_property: property | chosen_resolution: choice`
triple is passed to the producer. Only an explicit completion marker that
echoes the exact triple under `### Applied Conflict Resolutions` may close
the record. Unknown, ambiguous, abandoned, or mismatched returns leave it
open and cannot advance the checker.

## Alternatives considered

| Rank | Mechanism | Performance | Simplicity | Ecosystem | Maintenance | Decision |
|---|---|---|---|---|---|---|
| 1 | Fixed owned slot in existing `REVIEWS.md` | One bounded linear scan; no extra I/O | Reuses the existing artifact and shell/Node stdlib | Works in every current runtime | One shared authority with explicit inline projections | Chosen |
| 2 | Separate JSON state file | Linear parse, plus another file read/write | Strong structure but adds an artifact, schema, lifecycle, and merge surface | Native JSON support | Requires migration, cleanup, and ownership rules | Rejected |
| 3 | Global scan of review prose | One linear scan | Fewest initial lines | No dependencies | Forgeable by reviewer text; cannot distinguish state from commentary | Rejected |
| 4 | User-only arbitration with no persistence | No artifact I/O | Smallest code path | Runtime-neutral | Loses blockers across resume and cannot gate convergence | Rejected |

The chosen mechanism wins in the required order: bounded linear performance,
minimum new surface, native runtime support, then maintenance cost. It adds no
dependency and no general parser abstraction.

## Consequences

- Advisory hints cannot force avoidable arbitration.
- Reviewer prose and raw delimiters cannot forge persisted state.
- A legacy review artifact without the owned slot blocks until regenerated;
  this is deliberate fail-closed behavior.
- The inline producer prompts must remain consistent with
  `gsd-core/references/planner-revision.md`; contract tests cover all five.
- The shell reader remains embedded in the convergence workflow because it has
  one caller. Extracting a module would add a seam without reuse.

## Verification

- `tests/revision-remediation-binding.test.cjs` executes the real embedded gate
  against a pre-gate user artifact and missing or empty path boundaries; its
  remaining protocol checks inspect the shipped source contract.
- `tests/fixtures/representative/plan-revision-conflicts/` contributes the
  user artifact, whose shape was not derived from this protocol.
- Generated ADR index validation and the repository's full lint/test gates
  remain required before publication.

## Revisit if

- another independent writer or reader needs the same record grammar, making a
  typed shared module cheaper than duplicated parsing; or
- `REVIEWS.md` stops being the durable plan-review artifact.
