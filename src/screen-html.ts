import { createHash } from "node:crypto";
import type { ScreenElement } from "./schema.js";

/**
 * Extraction of the `data-req-*` traceability attributes from a mockup's HTML.
 *
 * The convention (one attribute set per significant element):
 *
 *   <button data-req-el="btn-confirm-booking"
 *           data-req-stories="US-014,US-021"
 *           data-req-role="action">Confirmer</button>
 *
 *   data-req-el        stable element id, unique within the screen — the anchor
 *                      step definitions bind to, instead of a CSS selector.
 *   data-req-stories   story ids this element materializes (comma/space separated).
 *   data-req-role      action | input | display | feedback | navigation.
 *   data-req-field     data-model field the element renders or captures.
 *   data-req-target    screen id this element navigates to (flow exits).
 *   data-req-component id of a shared component the screen embeds at this point.
 *
 * Mockups are self-contained static HTML with no build step, so this is a small
 * tag scanner rather than a full DOM parser: it walks quoted-attribute-aware tag
 * matches, which is enough for generated markup and keeps requ dependency-free.
 */

/** Matches one tag, tolerating `>` inside quoted attribute values. */
const TAG_RE = /<([a-zA-Z][\w:-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
const ATTR_RE = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;

/** Elements that never have a closing tag, so they never have inner text. */
const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const MAX_TEXT = 160;

export interface ParsedScreenHtml {
  elements: ScreenElement[];
  /** Shared component ids referenced via `data-req-component`. */
  componentRefs: string[];
  /** Screen ids referenced via `data-req-target`. */
  targets: string[];
  /** `data-req-el` values declared more than once in this document. */
  duplicates: string[];
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "";
  }
  return out;
}

/** Split a comma- or whitespace-separated attribute list, e.g. "US-014, US-021". */
function splitList(v: string | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const part of v.split(/[,\s]+/)) {
    const t = part.trim();
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

function collapse(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_TEXT ? `${t.slice(0, MAX_TEXT - 1)}…` : t;
}

/**
 * Text content of the element opened at `openEnd`, tags stripped. Scans forward
 * counting same-name opens/closes so nested markup doesn't end the element early;
 * bails out at the end of the document for unbalanced markup.
 */
function innerText(html: string, openEnd: number, tag: string): string {
  if (VOID_TAGS.has(tag)) return "";
  const lower = tag.toLowerCase();
  const re = new RegExp(`<(/?)(${lower})\\b((?:"[^"]*"|'[^']*'|[^>"'])*)>`, "gi");
  re.lastIndex = openEnd;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[1] === "/") {
      depth--;
      if (depth === 0) return collapse(stripTags(html.slice(openEnd, m.index)));
    } else if (!m[3].trimEnd().endsWith("/")) {
      depth++;
    }
  }
  return collapse(stripTags(html.slice(openEnd)));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

/** Parse a mockup's HTML into its traced elements and references. */
export function parseScreenHtml(html: string): ParsedScreenHtml {
  const elements: ScreenElement[] = [];
  const componentRefs: string[] = [];
  const targets: string[] = [];
  const seen = new Set<string>();
  const duplicates: string[] = [];

  TAG_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TAG_RE.exec(html)) !== null) {
    const raw = m[2];
    if (!raw.includes("data-req-")) continue;
    const tag = m[1].toLowerCase();
    const attrs = parseAttrs(raw);

    const component = attrs["data-req-component"];
    if (component && !componentRefs.includes(component)) componentRefs.push(component);

    const target = attrs["data-req-target"];
    if (target && !targets.includes(target)) targets.push(target);

    const el = attrs["data-req-el"];
    if (!el) continue;
    if (seen.has(el)) {
      if (!duplicates.includes(el)) duplicates.push(el);
    } else {
      seen.add(el);
    }

    elements.push({
      el,
      role: attrs["data-req-role"] ?? "",
      stories: splitList(attrs["data-req-stories"]),
      ...(attrs["data-req-field"] ? { field: attrs["data-req-field"] } : {}),
      ...(target ? { target } : {}),
      tag,
      text: innerText(html, m.index + m[0].length, tag),
    });
  }

  return { elements, componentRefs, targets, duplicates };
}

/** Short content hash used as the default screen version. */
export function htmlVersion(html: string): string {
  return createHash("sha1").update(html).digest("hex").slice(0, 12);
}
