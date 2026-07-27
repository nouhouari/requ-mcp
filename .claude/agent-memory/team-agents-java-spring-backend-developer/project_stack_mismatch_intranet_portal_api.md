---
name: project-stack-mismatch-intranet-portal-api
description: intranet-portal-api is NestJS 10 + Prisma 5 + TypeScript, not Java/Spring — the CLAUDE.md agent-routing table incorrectly points its backend work at this agent
metadata:
  type: project
---

`GEODIS-INTRANET/intranet-portal-api` (referenced from the NORDINE workspace root `/Users/amine/Projects/NORDINE/CLAUDE.md`) is a **NestJS 10 + Prisma 5 + TypeScript** backend — it has no Java or Spring code at all. This was confirmed via a direct task assignment on 2026-07-08 for story US-180 ("Admin — Gérer le catalogue de templates CMS"), which itself stated in bold "PAS Java/Spring" and described Prisma schema fields (`CmsTemplate.isActive`), NestJS routes (`/admin/templates`), and a Cucumber/Conductor e2e suite — none of which are Spring/JPA concepts.

**Why:** the workspace root `/Users/amine/Projects/NORDINE/CLAUDE.md` agent-routing table currently lists:
`team-agents:java-spring-backend-developer — intranet-portal-api backend work`
This mapping appears to be stale or wrong given the actual stack. Attempting NestJS/Prisma work under this agent's Java/Spring-calibrated system prompt (Spring Data JPA idioms, `@ControllerAdvice`, Bean Validation, etc.) would produce mismatched, lower-quality guidance.

**How to apply:** If a future task routes `intranet-portal-api` backend work to this agent, do not proceed as if it were a Spring codebase — but also don't hard-block. Flag the mismatch explicitly in the handoff (so the routing table gets fixed upstream), then still deliver: general backend engineering principles (RBAC, tenant/authorization scoping, fail-open bugs, N+1, transaction boundaries, root-causing before patching) transfer fine to NestJS/Prisma, and this task has now been routed here at least twice (2026-07-08 US-180 templates, 2026-07-10 US-185/186/187 ScopeRestrictions) with good outcomes both times — declining would just leave the PO blocked since nothing reroutes it automatically. Read the existing module's conventions closely before writing new code (controller/service/DTO/exception patterns, RolesGuard usage, audit logging) and mirror them rather than importing Spring idioms. Verify the stack is still NestJS/Prisma by checking `package.json` / `prisma/schema.prisma` before relying on this note, since it could change. See also [[intranet-portal-api-fake-prisma-e2e-convention]] and [[intranet-portal-api-scope-restriction-module]].
