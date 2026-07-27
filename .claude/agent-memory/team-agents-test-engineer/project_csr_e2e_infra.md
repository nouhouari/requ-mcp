---
name: csr-e2e-infra
description: CSR Best-Practices E2E test infrastructure — runner command, known issues, and data invariants
metadata:
  type: project
---

## Runner command

The correct way to run the API E2E tests is:

```bash
cd /Users/amine/Projects/NORDINE/Best-Practices/e2e
node ./node_modules/.bin/cucumber-js \
  --config cucumber.js \
  --profile api \
  --format summary \
  --format "json:reports/cucumber-report.json" \
  [--tags "@smoke and @api"]
```

Do NOT use `npm test -- ...` (npm strips `--` args) and do NOT omit `--config cucumber.js --profile api` (otherwise web step defs load and cause ambiguity errors).

## Known data invariant: FicheCounter sync

After a DB re-seed, the `FicheCounter` table is reset (lastSeq=low) but previously-created fiches still exist with higher reference numbers. This causes a unique constraint violation (P2002) on POST /fiches → HTTP 500.

**Fix:** Run this SQL after a seed to sync counters:

```sql
UPDATE "FicheCounter" fc
SET "lastSeq" = actual.max_seq
FROM (
  SELECT
    theme::text AS theme,
    CAST(SPLIT_PART(reference, '_', 2) AS INTEGER) AS year,
    MAX(CAST(SPLIT_PART(reference, '_', 3) AS INTEGER)) AS max_seq
  FROM "Fiche"
  WHERE reference ~ '^[A-Z]+_[0-9]{4}_[0-9]+$'
  GROUP BY theme::text, CAST(SPLIT_PART(reference, '_', 2) AS INTEGER)
) actual
WHERE fc.theme::text = actual.theme
  AND fc.year = actual.year
  AND actual.max_seq > fc."lastSeq";
```

**Why:** The seed resets counters but doesn't clear test-run fiches (they accumulate across runs). Counter must be at or above the max reference already in the DB.
**How to apply:** Run this fix whenever POST /fiches returns 500 after a re-seed.

## Known step limitation: NEEDS_INFO→PENDING audit search

The step `la fiche N a subi la transition NEEDS_INFO vers PENDING` (audit-api.feature AC-6) had a bug where it searched only 5 pages × 100 fiches for a PENDING fiche with a NEEDS_INFO→PENDING audit entry. After many test runs accumulate 500+ fiches, the NEEDS_INFO fiche gets pushed beyond page 5.

**Fix applied (2026-06-25):** When no NEEDS_INFO fiche is found, the step now creates a fresh fiche and walks it through PENDING → IN_COMMITTEE → NEEDS_INFO → PENDING via the API (all as ADMIN), generating a fresh audit entry at the top of the list.

**File:** `/Users/amine/Projects/NORDINE/Best-Practices/e2e/step-definitions/api/http.steps.ts` around line 1599.

## Suite results (2026-06-25 post-fix)

- Smoke (@smoke and @api): **27/27** pass
- Full API suite: **44/44** pass
- Import runId: `api-smoke-2026-06-25`
- Coverage P1 (cumulative): **57.1%** (24/42 requirements verified)

## New feature files added (2026-06-25) — US-009, US-011, US-017

Three new feature files covering stories previously untested:

- `/Users/amine/Projects/NORDINE/Best-Practices/e2e/features/api/fiche-detail-api.feature` → @US-009 (4 scenarios, all pass)
- `/Users/amine/Projects/NORDINE/Best-Practices/e2e/features/api/fiche-edit-api.feature` → @US-011 (4 scenarios, all pass)
- `/Users/amine/Projects/NORDINE/Best-Practices/e2e/features/api/validation-queue-api.feature` → @US-017 (4 scenarios, all pass)

### Key data patterns learned

- ficheIdMap key 1 = first VALIDATED_STANDARD (visible to all — safe for unauthenticated/CONTRIBUTOR tests)
- ficheIdMap key 2 = first PENDING = **Jacqueline's** fiche (first CONTRIBUTOR in seed)
- ficheIdMap key 5 = second PENDING = **Jacqueline's** fiche again
- fetchPersonas().find(CONTRIBUTOR) always returns **Jacqueline** first (DISTRIBUTION EXPRESS)
- Sofia Almeida (GLOBAL CONTRACT LOGISTICS) is contributors[1] — owns the 4th PENDING in seed

**Critical pattern for "CONTRIBUTOR can't see/edit ANOTHER's PENDING":** Use pseudo-ids 50/51 (never overlapping with pre-mapped IDs 1-12) and the new Given steps:
  - `il existe une fiche PENDING avec l'id N dont je ne suis pas l'auteur` — creates as Sofia, maps to N, switches back to Jacqueline
  - `il existe une fiche PENDING avec l'id N appartenant a un autre CONTRIBUTOR` — same but different wording for edit tests

### Validation queue (US-017) API params

- `toValidate=true` — returns PENDING fiches for VALIDATOR (scoped to their LoB)
- `adminStatuses=PENDING` — array filter (plural param name), ADMIN-accessible
- `adminStatuses=IN_COMMITTEE` — same array filter
- `mine=true` — restricts to fiches authored by current user (all statuses)
- No `adminStatus` (singular) param exists — always use `adminStatuses` (plural)

### PATCH /fiches/:id

- Exists and works: `PATCH /api/fiches/:id` with `{ title: "..." }` body
- Step added: `j'envoie PATCH a {string} avec le titre {string}`
- assertCanEdit rules: ADMIN always; VALIDATOR on same LoB always; CONTRIBUTOR only on own PENDING/NEEDS_INFO; others → 403

Import runId: `api-gaps-2026-06-25` (12 scenarios, 12 pass)
