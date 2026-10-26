---
type: Changed
pr: 5490
---
**`/gsd:ship` now refuses a phase that ROADMAP.md does not record complete, and completed phases are recorded** — `roadmap analyze` gains `roadmap_record` (and `phase add`/`add-batch`/`insert` gain `roadmap_entry`), a backlog `</details>` after the active milestone no longer hides it from the roadmap writers, `update-plan-progress` and `phase complete` write Status/Completed to the phase table instead of an earlier versions table, the executor flows stop when `update-plan-progress` declines (`missing_phase_details`), and ship blocks a phase whose checklist entry or progress-table row does not read complete or that has no such record; `phase add`/`add-batch`/`insert` write that record (a checklist entry, else a progress-table row) so a tool-created phase, including a `phase_naming: custom` id, can ship, and `roadmap analyze`'s `phases`, `missing_phase_details` and `checkbox_conflict` now also read a plain `- [ ] Phase N: …` checklist entry (#5221).
