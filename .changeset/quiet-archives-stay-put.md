---
type: Fixed
pr: 1
---
**`roadmap update-plan-progress` now edits only the active milestone, whatever the archive's tag case, attributes or position** — the active region was cut at the last literal `</details>`, so a `<details open>` wrapper around the active milestone, uppercase `<DETAILS>` archives, or archives placed after the active section either declined with `missing_phase_details` or ticked and annotated the archive instead. Archived `<details>` blocks are now hidden for the whole edit and restored byte-for-byte. (#5553)
