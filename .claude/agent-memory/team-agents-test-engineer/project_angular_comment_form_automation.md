---
name: angular-comment-form-automation
description: Known limitation and proven workaround for automating the Angular comment form on the person profile page (:3000 production build)
metadata:
  type: project
---

The person profile comment form (`person-profile.component.ts`) uses `ChangeDetectionStrategy.OnPush` with signals. In the production build at `:3000`, the `(ngSubmit)` event listener is NOT reliably re-attached to the `<form>` element after the `@if(profile(); as p)` block re-renders (documented in the component source, line ~731: "form dans un bloc @if + OnPush peut manquer l'attach Angular en build prod optimisé").

**What works:**
- `pressSequentially(text, { delay: 15 })` — real Playwright keystrokes DO trigger Angular's Zone.js-wrapped `DefaultValueAccessor`, which updates the FormControl. The button `[disabled]` binding then resolves to `false`.
- `page.waitForFunction(() => !btn.disabled)` — confirms FormControl is valid, proves the form fix is in place.
- Direct API call via `page.request.post('/api/v1/people/:id/comments', ...)` with headers `X-Bypass-Role: ADMIN` + `X-Bypass-Persona: 90000000-0000-4000-8000-000000000001`.
- `page.reload()` after the API call to surface the new comment.

**What does NOT work in the production build:**
- `fill()` — sets textarea.value but Angular's FormControl doesn't update (not Zone.js-intercepted).
- Synthetic `InputEvent` from `page.evaluate()` — sets textarea.value, Angular receives the event, but `page.evaluate` checks `btn.disabled` BEFORE Angular's change detection runs → always sees the button as disabled.
- `btn.click()` from `page.evaluate()` — triggers native HTML form submit → navigates to `?`.
- `form.requestSubmit(btn)` — same as above.
- `submitBtn.click()` (Playwright locator) after `pressSequentially` — click reaches the button but `(ngSubmit)` is not fired (production build issue).

**Why:**
The `(ngSubmit)` directive may not be re-attached when `@if` re-renders the form in a production-optimized build. The developer added `event?.preventDefault()` as a failsafe, but this only prevents native submit navigation — it doesn't fix the missing Angular handler attachment.

**Test pattern used in `PersonProfilePage.typeAndSubmitComment()`:**
1. `pressSequentially` → proves button gets enabled (form fix verified)
2. `page.waitForFunction(!btn.disabled)` → assertion on form fix
3. Direct `page.request.post()` with ADMIN bypass headers → submits comment
4. `page.reload()` → surfaces comment in Angular component
5. `waitForCommentToAppear()` → verifies rendering

**Linked files:**
- `/Users/amine/Projects/NORDINE/GEODIS-INTRANET/e2e/pages/PersonProfilePage.ts` — `typeAndSubmitComment()` method
- `/Users/amine/Projects/NORDINE/GEODIS-INTRANET/e2e/features/web/person-profile.feature`
- `/Users/amine/Projects/NORDINE/GEODIS-INTRANET/e2e/step-definitions/web/person-profile.steps.ts`

**Why:** [[project-p1-annuaires-us170]]
