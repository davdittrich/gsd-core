---
type: Fixed
pr: 5550
---
**An untracked `.planning/state.json` is now git-ignored, so `/gsd-ship` no longer refuses on it** — the derived cache was rewritten at every boundary command but never committed or ignored, leaving the tree dirty after a workflow's final commit. Each clone's `.git/info/exclude` now lists it (skipped when `commit_docs` is false); a copy committed earlier stays tracked and modified, and the how-to gives the one-time `git rm --cached` to untrack it. (#5505)
