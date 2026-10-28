---
type: Fixed
pr: 5550
---
**An untracked `.planning/state.json` is now git-ignored, so `/gsd-ship` no longer refuses on it** — the derived cache was rewritten at every boundary command but never committed or ignored, leaving the tree dirty after a workflow's final commit. Each clone's `.git/info/exclude` now lists it (skipped when `commit_docs` is false); a copy committed earlier stays tracked, and `/gsd-health` reports it as warning `W031` with the exact, idempotent `git --literal-pathspecs rm --cached --ignore-unmatch` to run once, because GSD never changes your index itself. (#5505)
