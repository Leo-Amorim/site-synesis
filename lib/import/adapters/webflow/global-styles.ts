/**
 * Webflow site stylesheet → resolved global-style index.
 *
 * The clipboard (XSCP) omits the site's global stylesheet: tag selectors
 * (`h1`–`h6`, `body`, `blockquote`, …), site-wide class definitions, and the
 * `:root` design tokens that classes reference via `var(--token)`. That's why
 * classes like `Background Primary Soft` or `Text Secondary` arrive with an
 * empty `styleLess` — their only declaration is a variable reference Webflow
 * strips on copy.
 *
 * This parser takes the published `*.webflow.shared.*.css` and produces a
 * lookup the importer can join against by class *name* (kebab-cased to match
 * Webflow's selector convention) and by tag. All `var(--token)` references are
 * resolved to concrete values up front so the result feeds straight into the
 * shared CSS → Tailwind mapper.
 *
 * Scope (deliberately conservative for now):
 *   - top-level `:root` variables, single-class selectors (`.foo-bar`), and a
 *     fixed set of tag selectors,
 *   - `@font-face` family names (for installation),
 *   - `@media` / `@keyframes` blocks are skipped (responsive variants still
 *     come through from the clipboard's own per-class `variants`).
 */

export interface GlobalStylesheet {
  /** kebab class name (no leading dot) → resolved CSS declaration block. */
  classByName: Map<string, string>;
  /** tag name (`h1`–`h6`, `body`, `blockquote`, `p`, `a`, `li`) → resolved block. */
  tagRules: Map<string, string>;
  /** Font families referenced by `@font-face` / the body class (for install). */
  fontFamilies: string[];
  /** The `.body` declaration block, applied as the document's base text style. */
  bodyDecl?: string;
}

interface RawRule {
  selector: string;
  body: string;
  atRule?: string;
}

/**
 * Split a stylesheet into top-level rules, tracking balanced braces so nested
 * at-rules (`@media`, `@keyframes`) are captured as a single block rather than
 * mis-split. Comments are assumed already stripped.
 */
function tokenizeRules(css: string): RawRule[] {
  const rules: RawRule[] = [];
  let i = 0;
  const len = css.length;

  while (i < len) {
    const braceOpen = css.indexOf('{', i);
    if (braceOpen === -1) break;

    const prelude = css.slice(i, braceOpen).trim();

    // Find the matching close brace, accounting for nesting (@media/@keyframes).
    let depth = 1;
    let j = braceOpen + 1;
    while (j < len && depth > 0) {
      const ch = css[j];
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
      j++;
    }
    const body = css.slice(braceOpen + 1, j - 1);

    if (prelude.startsWith('@')) {
      const atRule = prelude.split(/\s+/)[0].toLowerCase();
      rules.push({ selector: prelude, body, atRule });
    } else {
      rules.push({ selector: prelude, body });
    }

    i = j;
  }

  return rules;
}

/** Parse `--name: value;` pairs out of a `:root` block. */
function parseVars(body: string, into: Map<string, string>): void {
  for (const decl of body.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const name = decl.slice(0, idx).trim();
    const value = decl.slice(idx + 1).trim();
    if (name.startsWith('--') && value) into.set(name, value);
  }
}

/** Replace `var(--token[, fallback])` with the resolved value (recursively). */
function makeVarResolver(vars: Map<string, string>): (decl: string) => string {
  const resolveOnce = (decl: string): string =>
    decl.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*))?\)/g, (_m, name: string, fallback?: string) => {
      const v = vars.get(name);
      if (v !== undefined) return v;
      return (fallback ?? '').trim() || 'inherit';
    });

  return (decl: string): string => {
    let prev = decl;
    // Resolve up to a few passes in case a token resolves to another var().
    for (let n = 0; n < 5; n++) {
      const next = resolveOnce(prev);
      if (next === prev) break;
      prev = next;
    }
    return prev;
  };
}

/** Pull the `font-family` value (first family, unquoted) from a declaration block. */
function fontFamilyOf(decl: string | undefined): string | undefined {
  if (!decl) return undefined;
  const m = decl.match(/font-family:\s*([^;]+)/i);
  if (!m) return undefined;
  return m[1].split(',')[0].trim().replace(/^["']|["']$/g, '');
}

const TAG_SELECTORS = /^(h[1-6]|blockquote|p|a|li|body)$/;
const SINGLE_CLASS = /^\.[a-zA-Z0-9_-]+$/;

/** Append `decl` onto an existing map entry (later declarations win on merge). */
function appendDecl(map: Map<string, string>, key: string, decl: string): void {
  const existing = map.get(key);
  const trimmed = decl.trim().replace(/;?\s*$/, '');
  if (!trimmed) return;
  map.set(key, existing ? `${existing}; ${trimmed}` : trimmed);
}

/**
 * Collapse a declaration block so each property appears once with its LAST
 * value — mirroring the CSS cascade when the same selector is defined twice
 * (e.g. a normalize `blockquote { border-left: 5px solid … }` followed by a
 * theme `blockquote { border-left: 1px #000 }`, where the later, style-less
 * value resets the border to invisible). Without this, both survive as separate
 * arbitrary utilities and the wrong one wins.
 */
function dedupeDeclarations(block: string): string {
  const order: string[] = [];
  const values = new Map<string, string>();
  for (const decl of block.split(';')) {
    const idx = decl.indexOf(':');
    if (idx === -1) continue;
    const prop = decl.slice(0, idx).trim().toLowerCase();
    const val = decl.slice(idx + 1).trim();
    if (!prop || !val) continue;
    if (!values.has(prop)) order.push(prop);
    values.set(prop, val);
  }
  return order.map((p) => `${p}: ${values.get(p)}`).join('; ');
}

export function parseGlobalStylesheet(css: string): GlobalStylesheet {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = tokenizeRules(clean);

  // Pass 1: collect :root variables.
  const vars = new Map<string, string>();
  for (const rule of rules) {
    if (rule.atRule) continue;
    if (rule.selector.split(',').some((s) => s.trim() === ':root')) {
      parseVars(rule.body, vars);
    }
  }
  const resolveVars = makeVarResolver(vars);

  // Pass 2: index class + tag rules, and collect @font-face families.
  const classByName = new Map<string, string>();
  const tagRules = new Map<string, string>();
  const fontFamilies = new Set<string>();

  for (const rule of rules) {
    if (rule.atRule) {
      if (rule.atRule === '@font-face') {
        const family = fontFamilyOf(rule.body);
        if (family) fontFamilies.add(family);
      }
      // @media / @keyframes intentionally skipped.
      continue;
    }

    const resolvedBody = resolveVars(rule.body);

    for (const rawSel of rule.selector.split(',')) {
      const sel = rawSel.trim();
      if (SINGLE_CLASS.test(sel)) {
        appendDecl(classByName, sel.slice(1).toLowerCase(), resolvedBody);
      } else if (TAG_SELECTORS.test(sel)) {
        appendDecl(tagRules, sel.toLowerCase(), resolvedBody);
      }
      // Compound / descendant / pseudo / id selectors are skipped.
    }
  }

  // Collapse duplicate properties per selector (last value wins) so repeated
  // normalize/theme rules resolve the same way the browser cascade would.
  for (const [k, v] of classByName) classByName.set(k, dedupeDeclarations(v));
  for (const [k, v] of tagRules) tagRules.set(k, dedupeDeclarations(v));

  const bodyDecl = classByName.get('body');
  const bodyFamily = fontFamilyOf(bodyDecl);
  if (bodyFamily) fontFamilies.add(bodyFamily);

  return {
    classByName,
    tagRules,
    fontFamilies: [...fontFamilies],
    bodyDecl,
  };
}

/** Map a Webflow class display name to its CSS selector form ("Text Secondary" → "text-secondary"). */
export function kebabClassName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-');
}
