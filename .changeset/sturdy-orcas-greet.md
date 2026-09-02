---
type: Fixed
pr: 4115
---
**TDD RED now has a task-scoped, locally observed contract** — the RED step accepted any non-zero exit as proof a test was red, so a collection error, a crashed fixture or an unrelated failing test all authorized GREEN, while a legitimate outside-in RED that never reaches the test body was indistinguishable from them. `gsd-core/references/tdd.md` now carries a `<red_contract>` declaration, a `red-evidence:` commit trailer, the predicate that judges one against the other, and the eight outcomes it decides; the executor, planner, execute-plan workflow and MVP+TDD gate carry one parser-selected plan/task identity and selected `program`/`argv_json` invocation, while canonical docs distinguish locally observed exit/stderr from declared semantics and never claim hosted provenance. (#3770)
