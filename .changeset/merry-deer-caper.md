---
type: Fixed
pr: 5489
---
**Agent task commits no longer sweep in files another session staged** — prompts, workflows, references and the Pi `gsd-debug` skill ran a bare `git commit` that records the whole index, so a foreign staged file landed in a commit whose message described only the task; each now appends a `--` pathspec, and a guard test fails on any unscoped `git commit` in those surfaces. `/gsd:fast` now also exits with "index not clean" when files are already staged before its commit step. (#5211)
