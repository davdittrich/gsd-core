---
type: Fixed
pr: 5461
---
**The TDD RED-commit gate now recognises nested test paths** — `crates/core/tests/…`, `src/__tests__/…` and `pkg/api/test_x.py` count as test files at any depth, not only at the repo root; `test_*.py` now matches the file name only, so a root-level directory such as `test_utils/` no longer makes every `.py` file under it a test file; a file there still counts when another convention matches it, such as `*_test.py` (#5181).
