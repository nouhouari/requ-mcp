---
name: project-feature-tag-alignment
description: Web feature files US-019..US-035 had a numbering shift — tags corrected to match YAML story content (2026-06-25)
metadata:
  type: project
---

Web feature files US-019 to US-035 in `/Users/amine/Projects/NORDINE/Best-Practices/e2e/features/web/` had a 1-position numbering shift starting at US-019. The file names (and thus step-definition imports) are stable, but the `@US-xxx` tag inside each feature was corrected.

**Why:** The feature files were created with a shifted numbering — the content did not match the YAML story of the same number. Multiple feature files (US-020 through US-024) test aspects of the same US-019 validation workflow.

**Corrected tag mapping (file → correct @tag):**
- US-019-needs-info → @US-019 (unchanged)
- US-020-validate → @US-019 (single validation = part of US-019 workflow)
- US-021-reject → @US-019 (reject = AC-3 of US-019)
- US-022-operational → @US-019 (operational status = AC-5 of US-019)
- US-023-bulk → @US-020
- US-024-needs-info-return → @US-019 (NEEDS_INFO return to PENDING)
- US-025-audit → @US-032
- US-026-comments → @US-022
- US-027-delete-comment → @US-024 (modération)
- US-028-likes → @US-023
- US-029-notif-types → @US-025
- US-030-bell → @US-026
- US-031-mark-read → @US-027
- US-032-dashboard → @US-028
- US-033-featured → @US-029
- US-034-admin-table → @US-030
- US-035-quicknav → @US-031

**How to apply:** When writing new web feature files for US-021 through US-035 YAML stories, note that US-021 (Spotlight), US-033-US-035 YAML stories (audit trail, i18n) have NO dedicated feature file yet — only tags pointing to them from these files.

See [[project_csr_e2e_infra]] for E2E runner info.
