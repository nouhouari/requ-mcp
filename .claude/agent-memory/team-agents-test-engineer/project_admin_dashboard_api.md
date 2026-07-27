---
name: project-admin-dashboard-api
description: CSR Best-Practices admin dashboard API E2E coverage — US-028/029/030/031 endpoints, step defs added, 18/18 passing
metadata:
  type: project
---

## C-ADMIN API test coverage — US-028/029/030/031

**Fact:** 18 scenarios written and all passing (run 2026-06-25, runId `api-admin-2026-06-25`).

**File:** `/Users/amine/Projects/NORDINE/Best-Practices/e2e/features/api/admin-dashboard-api.feature`

**Step defs added to** `/Users/amine/Projects/NORDINE/Best-Practices/e2e/step-definitions/api/http.steps.ts`:
- `j'envoie POST a {string} avec le cookie et le body featured {word}` → POST /:id/featured with {featured: bool}
- `j'ai mis la fiche {int} en avant` → pre-condition sets featured=true
- `toutes les fiches dans le body ont le champ featured a true` → asserts featured field
- `le body est un tableau de fiches avec au moins un element` → non-empty list check
- `toutes les fiches dans le body ont le adminStatus {word}` → filters adminStatus per item
- `le total de fiches est superieur a {int}` → checks body.total > N
- `le body byStatus contient la cle {word}` → checks dashboard byStatus array contains key
- `le CSV contient des lignes avec le statut {word}` → checks CSV data rows for status string

**Endpoint reality confirmed:**
- `GET /api/fiches/dashboard` — ADMIN only (403 for CONTRIBUTOR/VALIDATOR), returns {total, awarded, validated, validationRate, byStatus[], byTheme[], byLob[], impact}
- `GET /api/fiches/stats` — public, returns {totalFiches, totalLikes, totalComments, awarded, impactScore} — lightweight, no byStatus breakdown
- `GET /api/fiches/export` — ADMIN or VALIDATOR only (403 for CONTRIBUTOR), returns CSV with BOM (utf-8-sig)
- `POST /api/fiches/:id/featured` — ADMIN only, body {featured: bool}, returns {id, featured}
- `GET /api/fiches?featured=true` — public filter, returns fiches where featured=true
- `GET /api/fiches?adminStatuses=PENDING` — ADMIN sees all; CONTRIBUTOR sees only own + validated

**Why:** `/fiches/stats` is a different (simpler) endpoint than `/fiches/dashboard`; the dashboard is ADMIN-gated and includes byStatus breakdown used for KPIs. The `featured` endpoint is `POST /fiches/:id/featured`, NOT `GET /fiches/featured` (which is a 404).

**How to apply:** When extending admin tests, reuse the `ficheIdMap` pseudo-id 1 (VALIDATED_STANDARD) for featured tests. CSV export has a UTF-8 BOM — strip it with `.replace(/^﻿/, '')` before parsing lines.
