---
type: Fixed
pr: 70
---
Executor, debugger and debug-session-manager prompts now scope their raw `git commit` with a `--` pathspec, so files staged by another session no longer land in task commits; a guard test fails on any unscoped `git commit` in `agents/*.md` (#5211).
