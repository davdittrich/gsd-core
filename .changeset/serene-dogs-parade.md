---
type: Fixed
pr: 5419
---
**Reviewer lane no longer forwards its prompt to a redirect target** — the lane HTTP seam followed redirects, so a configured `review.<lane>_host` answering 307/308 received the full review prompt (plans, requirements, research) at a host the user never consented to. The seam now refuses redirects: any 3xx fails the lane with `redirect refused (HTTP <status>)` and the body is not re-sent. Non-redirecting hosts behave as before.
