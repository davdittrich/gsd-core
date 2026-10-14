---
type: Fixed
pr: 0
---
**`capability install` from a git URL no longer copies the clone's `.git` into the capability directory** — at project scope it landed as an embedded repository that `git add -A` staged as a gitlink. Capabilities installed from git before this fix keep their old content hash.
