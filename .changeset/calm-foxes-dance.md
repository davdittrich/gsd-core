---
type: Fixed
pr: 31
---
**Capability contributions aimed at the executor now actually reach it** — a contribution declared into the `executor` role at the `execute:wave:pre` loop point was resolved and rendered, then silently dropped, because no executor dispatch prompt had a landing site for it. The orchestrator now concatenates the `into == "executor"` fragments into `WAVE_CONTRIBUTIONS` and substitutes them into the dispatched prompt on both the harness-worktree and orchestrator-worktree surfaces. (#4350)
