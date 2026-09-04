---
type: Added
pr: 20
---
**`/gsd:review` (and `/gsd:plan-review-convergence`, which delegates to it) now renders active `review:pre` reviewer contributions into the shared reviewer prompt** — a capability that already injects guidance for the planner/checker/executor (e.g. a simplicity mandate) now reaches external AI reviewers too, so a plan can't comply with an active capability's constraints while its reviewers evaluate it without them. Byte-identical no-op when no reviewer contribution is active; lanes with `promptChannel: 'none'` (e.g. CodeRabbit) are unaffected, since they never read the prompt file. (#3997)
