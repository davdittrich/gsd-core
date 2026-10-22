---
type: Fixed
pr: 4507
---
**Capability predicate gates receive phase context** — The `execute:post` and `plan:post` predicate dispatches now forward every `${PHASE_*}` value their checks interpolate (`--phase-number`, `--phase-dir`, `--phase-req-ids`), so a predicate referencing one no longer sees an empty string. (#4483)
