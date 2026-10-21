---
type: Changed
pr: 5413
---
**The agent model guard keeps one escalation record per agent and model** — sibling plans that escalate the same agent to different models no longer overwrite each other's record, so `hooks.agent_model_guard: "deny"` no longer blocks a legitimate parallel escalation. (#5524)
