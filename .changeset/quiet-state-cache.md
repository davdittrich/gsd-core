---
type: Fixed
pr: 5550
---
**`.planning/state.json` is now git-ignored, so `/gsd-ship` no longer refuses on it** — the derived cache was rewritten at every boundary command but never committed or ignored, leaving the tree dirty after a workflow's final commit. Each clone's `.git/info/exclude` now lists it; a copy committed earlier is left tracked, and the how-to gives the one-time `git rm --cached` to untrack it. (#5505)
