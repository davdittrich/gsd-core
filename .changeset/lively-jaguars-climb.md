---
type: Fixed
pr: 5469
---
**`/gsd-pr-branch` anchors replay on a published marker and handles an existing `-pr` branch** — the replay starts after the last published tip recorded in `refs/gsd/pr-published/<working-branch>`, so commits already published are not re-picked. A leftover `-pr` branch is replaced when already merged and refused by name when not (#5469).
