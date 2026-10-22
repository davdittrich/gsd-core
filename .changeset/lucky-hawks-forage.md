---
type: Fixed
pr: 5618
---
execGit and every other runtime git spawn no longer inherit GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE or the other repo-location variables, so cwd always selects the repository (#5548).
