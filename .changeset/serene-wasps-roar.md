---
type: Fixed
pr: 5549
---
**`roadmap update-plan-progress` no longer ticks a plan row in a shipped milestone or another phase** — a completed plan's checkbox was ticked at its first match anywhere in ROADMAP.md, so an archived `<details>` milestone or a sibling phase sharing the plan id got the tick instead of the active phase. Rows are now ticked only inside the updated phase's own section or checklist entry within the active milestone, the same scoping `phase complete` uses, and a `<details>` block after the active milestone no longer stops ticking. (#5483)
