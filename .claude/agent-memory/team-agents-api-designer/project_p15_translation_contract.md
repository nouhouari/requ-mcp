---
name: project-p15-translation-contract
description: Contrat API P15 Traduction DeepL — état du spec, stub mode, points ouverts, mapping stories
metadata:
  type: project
---

Le spec OpenAPI 3.1 du module Traduction (P15) est gelé à :
`GEODIS-INTRANET/intranet-portal-api/docs/api/translation.openapi.yaml`

**Why:** build frontend + backend en parallèle sans la clé DeepL (stub-first). La clé sera fournie par le PO ; DPA signé.

**How to apply:** lors de toute évolution du module traduction, partir de ce fichier comme source de vérité. Le CONTRACT-p15-api.md (prose) et l'ADR-008 restent les sources sémantiques.

### Endpoints gelés
- `POST /api/v1/translate` — READER+ — traduit texte ou HTML ; rate-limit 20 req/h/user ; cache PG TTL 30j
- `GET /api/v1/translate/quota` — ADMIN+ — quota mensuel DeepL (`used`, `total`, `resetDate`, `usagePercent`)

### Stub mode (`DEEPL_STUB_MODE=true`)
- Aucun appel DeepL. `translatedText` = `[FR→EN-GB] <texte original>`. `charCount: 0`. `cacheHit: false`.
- Mock Prism : `npx @stoplight/prism-cli mock docs/api/translation.openapi.yaml --port 4010`

### Codes d'erreur spécifiques
- `TRANSLATION_TEXT_TOO_LONG` → 422 (text > 128 000 chars)
- `TRANSLATION_LANG_NOT_ALLOWED` → 400 (targetLang hors liste blanche)
- `TRANSLATION_QUOTA_EXCEEDED` → 503 (quota mensuel épuisé)

### Points ouverts bloquants avant prod
- #3 DPA DeepL (juridique GEODIS) — BLOQUANT
- #4 flag `translationEnabled` sur CmsCategory si validé par PO — breaking change potentielle sur le DTO request (ajout champ catégorie)
- #1 Langues cibles (`AR` non confirmé)

### Mapping stories
- US-127 / REQ-166 → `POST /translate` (AC-1 couvert)
- US-128 / REQ-168 → SharePoint search (hors scope de translation.openapi.yaml)

### Style
Calqué sur `videos.openapi.yaml` : même ErrorEnvelope, même sessionCookie, même structure PaginationMeta, camelCase corps, ISO 8601 dates.
