---
type: Fixed
pr: 5415
---
**`capability install <git-url>#<ref>` now installs tags, branches and commits that are not the default-branch tip** — `#<tag>`, `#<branch>`, `#tag:<name>` and `#sha:<commit>` each stage exactly that ref instead of failing with `invalid reference`.
