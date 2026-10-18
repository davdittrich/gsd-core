---
type: Fixed
pr: 5461
---
**The TDD RED-commit gate now recognises nested test paths** — `crates/core/tests/…`, `src/__tests__/…` and `pkg/api/test_x.py` count as test files at any depth, not only at the repo root; `test_*.py` now matches only Python files, so `test_utils/foo.py` at the root no longer counts as a test file (#5181).
