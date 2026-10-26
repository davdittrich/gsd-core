---
type: Fixed
pr: 5617
---
**Non-Claude executor dispatch no longer breaks on apostrophes in the agent persona** — the orchestrator-worktree prompt is composed with a quoted heredoc with a per-dispatch random delimiter (the orchestrator substitutes a 16-lowercase-hex nonce; a guard halts on any other `GSD_NONCE` value), so spliced agent-skills text and inlined role files reach the executor byte-for-byte instead of closing the shell assignment or running as shell. The delivered prompt now ends with one trailing newline. A guard halts when the heredoc is not terminated (indented or CRLF terminator). (#5531)
