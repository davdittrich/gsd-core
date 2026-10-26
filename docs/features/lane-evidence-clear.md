---
id: 5019
title: Lane Evidence Clear
group: v1.7.0 Features
---

**Command:** `gsd_run lane-evidence-clear <review-path>`

**Purpose:** `/gsd-code-review` persists the external-reviewer evidence beside `REVIEW.md` (`<review>-lane-evidence.md`) so the `code-review-fix` workflow with `--auto` re-reviews can see it. Both that file and the scratch lane directory it names must go when the evidence is no longer wanted; six inline bash copies of that removal had drifted.

**Behavior:** one verb owns the removal. `code-review` calls it at `check_empty_scope`, in `commit_review` unless an `--auto` run keeps the evidence, and when the reviewer agent fails; `code-review-fix` calls it at every exit after `REVIEW_PATH` is computed. Line 1 of the file is data, not a path: only a 6-character alphanumeric value names a `$TMPDIR/gsd-review-lanes-<suffix>` (`/tmp` when unset) directory, and a symlinked directory is skipped. A symlinked evidence file is never read through but is itself unlinked. The verb never throws and exits 0 when there is nothing to remove.

**Known limits:** the fixer loop's read in `code-review-fix.md` repeats the 6-character check in bash (a workflow fence cannot import it); a test holds the two in step. The loop refreshes the file's mtime on each use and ignores a file idle for 6 hours.

**Reference:** [`lane-evidence-clear`](COMMANDS.md#lane-evidence-clear)
