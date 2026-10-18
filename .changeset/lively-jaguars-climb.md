---
type: Fixed
pr: 5486
---
**`/gsd-pr-branch` replays only commits after the last published tip and handles an existing `-pr` branch** — the last built tip is promoted to `refs/gsd/pr-published/<mode>/<target>/<working-branch>` once the `-pr` branch is merged (ancestry, or matching content after a squash or rebase merge), so discarded work is replayed. A leftover `-pr` branch is replaced when already merged and refused by name, with re-anchor and discard commands, when not (#5469).
