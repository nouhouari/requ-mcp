---
name: reference-geodis-intranet-memory-location
description: Where the real, actively-maintained agent memory for GEODIS-INTRANET/intranet-portal-web Angular work actually lives
metadata:
  type: reference
---

Angular frontend work on `intranet-portal-web` (part of the GEODIS-INTRANET workspace
component, sibling to `requ-mcp`) has its own rich, actively-maintained memory store at
`GEODIS-INTRANET/intranet-portal-web/.claude/agent-memory/team-agents-angular-frontend-developer/`
(and a mirrored copy at `GEODIS-INTRANET/.claude/agent-memory/team-agents-angular-frontend-developer/`).
It already contains dozens of project/feedback entries (Home redesigns 1-6, footer/P18
work, i18n P21, backtick-in-template-literal gotcha, etc.) going back to at least
2026-06-19.

**How to apply**: when a task involves `GEODIS-INTRANET/intranet-portal-web`, read that
project's own `MEMORY.md` first — it has far more relevant, current context than this
`requ-mcp`-scoped memory directory. Continue writing new GEODIS-INTRANET-specific
memories there (co-located with the code) rather than here, so they stay discoverable by
any future session working directly in that repo.
