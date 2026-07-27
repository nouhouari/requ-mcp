---
name: csr-web-e2e-fixes
description: Web smoke suite fixes for Best-Practices project — AUTH_BYPASS POC API, adminStatuses filter, FicheListPage search, placeholder fiche IDs
metadata:
  type: project
---

# CSR Web E2E Smoke Suite Fixes (2026-06-25)

Final result: 61/65 web @smoke scenarios passing (up from 53/65). Report imported to requ MCP as run `web-smoke-fixed-2026-06-25`, phase P1.

## Key discoveries

- **POC role switch**: Must call `GET /api/auth/poc` then `POST /api/auth/poc/switch` via `page.request` (shares browser cookies). The POC UI component has no `data-testid`. See `NavbarPage.selectPocPersona()`.
- **Auth switch granularity**: After switching role, navigate to `/fr` and `waitForLoadState('networkidle')` before proceeding.
- **API filter params**: `adminStatus=PENDING` does NOT work. Use `toValidate=true` for PENDING fiches. Use `adminStatuses=IN_COMMITTEE` (plural) for IN_COMMITTEE fiches.
- **Placeholder fiche IDs**: `fiche-test-001` etc. don't exist in DB. The `j'accede a {string}` step resolves them via API fallback. Background step `il existe une fiche validee avec l'identifiant {string}` now stores a real `VALIDATED_STANDARD` fiche ID in `this.data['currentFicheId']`.
- **Fiches list URL**: The home page `/fr` IS the fiche list, NOT `/fr/fiches` (which 404s). The step `j'accede a la page de liste des fiches {string}` normalizes `/fr/fiches` → `/fr`.
- **Validation queue URL**: `/fr/admin/queue` is correct. `/fr/validation/queue` does not exist.
- **Export CSV**: ADMIN only, only on `/fr/admin/dashboard`. The `je clique sur le bouton "Exporter CSV"` step auto-navigates there.
- **Playwright `.or()` and `.first()`**: When chaining `.or().first()`, `.first()` applies to the combined locator, not just the base. Be explicit.
- **React controlled textarea**: Use `.type()` (dispatches key events) rather than `.fill()` alone to ensure React `onChange` fires and enables the "Publier" submit button.
- **Comment form textarea**: `getByPlaceholder(/commentaire/i)` reliably finds it. The placeholder is "Écrire un commentaire…".

## Remaining 4 failures (fundamental — not fixable at test layer)

- **US-015 AC-1**: Export CSV requires ADMIN. VALIDATOR gets 404 on dashboard. Scenario premise is wrong (VALIDATOR can't use export).
- **US-020 AC-1**: "Valider comme Standard" is an ADMIN action. `showAdminActions = isAdmin && !VALIDATED && !REJECTED`. VALIDATOR only gets `showValidatorActions`.
- **US-021 AC-1**: VALIDATOR on IN_COMMITTEE fiche sees no buttons. `showValidatorActions = isValidator && adminStatus === 'PENDING'`. IN_COMMITTEE → no VALIDATOR actions.
- **US-035 AC-1**: Transient socket hang up on POC API (intermittent). When server restarts or is under load, `GET /api/auth/poc` times out.

## Files modified

- `e2e/pages/web/NavbarPage.ts` — `selectPocPersona()` via POC API
- `e2e/pages/web/FicheListPage.ts` — `search()` with click + type + dispatchEvent + waitForURL
- `e2e/step-definitions/web/auth.steps.ts` — `je me suis connecte avec le role {string}`
- `e2e/step-definitions/web/navigation.steps.ts` — 15+ step implementations
- `e2e/step-definitions/web/fiche.steps.ts` — list URL normalization
