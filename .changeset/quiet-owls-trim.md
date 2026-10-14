---
type: Fixed
pr: 0
---
**`capability install` from a git URL no longer copies the clone's `.git` into the capability directory** — at project scope it landed as an embedded repository that `git add -A` staged as a gitlink. Re-installing or updating a git capability recomputes its content hash without `.git`, so the hash changes once.
