---
type: Fixed
pr: 4184
---
**`/gsd-execute-phase` now runs advisory step hooks at `execute:wave:pre`** — external capabilities can refresh artifacts before executor spawning instead of silently waiting until wave end. (#4148)
