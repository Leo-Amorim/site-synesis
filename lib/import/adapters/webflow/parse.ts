/**
 * Webflow XSCP → neutral import IR.
 *
 * Rebuilds the tree from the flat `nodes[]` array (hierarchy lives in
 * `children: [id]`) and maps each Webflow node type onto an `ImportNode`.
 */

import type { ImportDocument, ImportNode, ImportStyleRef } from '@/lib/import/types';
import { buildStyleResolvers, extractFontFamilies } from '@/lib/import/adapters/webflow/styles';
import { imageFromNode } from '@/lib/import/adapters/webflow/assets';
import { buildCollectionNode, isCollectionWrapper, isDynamoType } from '@/lib/import/adapters/webflow/collections';
import { webflowIconSvg } from '@/lib/import/adapters/webflow/icons';
import { cssToClasses } from '@/lib/import/css';
import type { GlobalStylesheet } from '@/lib/import/adapters/webflow/global-styles';
import type { WebflowParseContext, XscpNode, XscpPayload } from '@/lib/import/adapters/webflow/xscp-types';

const HEADING_TAGS = /^h[1-6]$/;

/**
 * Layout defaults for Webflow widget node types whose layout normally comes
 * from Webflow's built-in framework CSS (`.w-slider`, `.w-tabs`, `.w-nav`, …)
 * rather than the user's own classes. That framework CSS isn't in the clipboard,
 * so without this sliders stack vertically, tab panes pile up, nav links wrap,
 * etc.
 *
 * These are applied as the element's `frameworkClasses` — the lowest layer in
 * the cascade — so they only fill gaps the user's classes don't already set
 * (e.g. a tab link that already has `display:flex` keeps it; we never override).
 *
 * NB: this reproduces the *visual* layout only. Widget behaviour (slide
 * transitions, tab switching, dropdown toggling) comes from Webflow's runtime,
 * which isn't in the clipboard — the user re-wires interactivity in Ycode.
 */
const WEBFLOW_WIDGET_CLASSES: Record<string, string[]> = {
  // Slider (.w-slider / .w-slider-mask / .w-slide) — slides sit in a row.
  SliderWrapper: ['relative'],
  SliderMask: ['flex'],
  SliderSlide: ['shrink-0'],
  // Tabs (.w-tabs / .w-tab-content / .w-tab-link). Inactive panes are hidden
  // separately (see TabsContent handling) to mirror Webflow's single-pane view.
  TabsWrapper: ['relative'],
  TabsContent: ['relative'],
  TabsLink: ['inline-block'],
  // Navbar (.w-nav*). The mobile hamburger (.w-nav-button) is hidden on desktop;
  // brand and links sit inline so the bar reads horizontally.
  NavbarWrapper: ['relative'],
  NavbarBrand: ['inline-block'],
  NavbarLink: ['inline-block'],
  NavbarButton: ['hidden'],
  // Dropdown (.w-dropdown*). The list is collapsed (closed) by default.
  DropdownWrapper: ['inline-block', 'relative'],
  DropdownToggle: ['inline-block', 'relative'],
  DropdownList: ['absolute', 'hidden'],
  // Forms — the success/error messages are hidden until the form is submitted.
  FormSuccessMessage: ['hidden'],
  FormErrorMessage: ['hidden'],
  // Background video (.w-background-video) clips its absolutely-positioned video.
  BackgroundVideoWrapper: ['relative', 'overflow-hidden'],
};

/**
 * Recover the Webflow navigator label for a node.
 *
 * Webflow's layer name is the element's primary (base) class name, which lives
 * in `styles[].name` — its `data.displayName` is almost always blank. So we use
 * an explicit `displayName` when present, otherwise fall back to the base
 * (non-combo) class name. This reproduces labels like "Hero Block" or
 * "Schedule Heading" in Ycode's layer tree.
 */
function resolveDisplayName(node: XscpNode, styles: ImportStyleRef[]): string | undefined {
  const explicit = typeof node.data?.displayName === 'string' ? node.data.displayName.trim() : '';
  if (explicit) return explicit;
  const base = styles.find((s) => !s.combo) ?? styles[0];
  return base?.name || undefined;
}

/**
 * Resolve every style on a node: its Webflow class-id list (base first) plus
 * any class *names* declared as a custom HTML `class` attribute (`xattr`).
 *
 * Webflow's design-system classes (e.g. `text-h2`, which sets the heading's
 * font size and weight) are frequently applied only via `xattr` and are absent
 * from the node's `classes` id list — so without this they'd be dropped and the
 * element would fall back to default typography.
 */
function resolveNodeStyles(node: XscpNode, ctx: WebflowParseContext): ImportStyleRef[] {
  const refs = ctx.resolveStyles(node.classes);
  const seen = new Set(refs.map((r) => r.key));

  for (const entry of node.data?.xattr ?? []) {
    if (entry?.name !== 'class' || typeof entry.value !== 'string') continue;
    for (const name of entry.value.split(/\s+/).filter(Boolean)) {
      const ref = ctx.resolveStyleByName(name);
      if (ref && !seen.has(ref.key)) {
        seen.add(ref.key);
        refs.push(ref);
      }
    }
  }

  return refs;
}

/** Serialize a rebuilt Webflow `DOM` SVG subtree back into inline SVG markup. */
function serializeDomSvg(node: XscpNode, ctx: WebflowParseContext): string {
  const tag = node.data?.tag;
  if (!tag) return '';
  const attrs = (node.data?.attributes ?? [])
    .filter((a) => a?.name)
    .map((a) => `${a.name}="${(a.value ?? '').replace(/"/g, '&quot;')}"`)
    .join(' ');
  const open = attrs ? `<${tag} ${attrs}>` : `<${tag}>`;
  const inner = (node.children ?? [])
    .map((id) => ctx.byId.get(id))
    .filter((n): n is XscpNode => n !== undefined)
    .map((child) => serializeDomSvg(child, ctx))
    .join('');
  return `${open}${inner}</${tag}>`;
}

/**
 * Extract inline SVG markup from a node, if it carries any:
 *   - `HtmlEmbed` nodes hold raw markup (often an `<svg>`) in `v`.
 *   - `DOM` nodes with `data.tag === 'svg'` are a rebuilt SVG element whose
 *     children (`path`, `g`, `defs`, …) are further `DOM` nodes.
 * Returns null when the node isn't an inline SVG (caller treats it normally).
 */
function extractInlineSvg(node: XscpNode, ctx: WebflowParseContext): string | null {
  if (node.type === 'HtmlEmbed') {
    const markup = typeof node.v === 'string' ? node.v : '';
    return markup.includes('<svg') ? markup : null;
  }
  if (node.type === 'DOM' && node.data?.tag === 'svg') {
    return serializeDomSvg(node, ctx);
  }
  return null;
}

/**
 * Flatten a run of inline children into a single string. Descends into inline
 * wrapper elements (e.g. `Span`) so their text isn't lost: Webflow wraps an
 * emphasised word — like a gradient "reasons" inside a heading — in a `Span`
 * whose text lives in a nested leaf, not on the `Span` node itself.
 */
function collectText(childNodes: XscpNode[], ctx: WebflowParseContext): string {
  return childNodes
    .map((n) => {
      if (n.type === 'LineBreak') return '\n';
      if (n.text === true) return n.v ?? '';
      const inner = (n.children ?? [])
        .map((id) => ctx.byId.get(id))
        .filter((c): c is XscpNode => c !== undefined);
      return inner.length > 0 ? collectText(inner, ctx) : (n.v ?? '');
    })
    .join('');
}

/**
 * True when every child is inline text content: a text leaf, a line break, or
 * an inline `Span` wrapper (whose own text is recovered by `collectText`). This
 * keeps headings/paragraphs with emphasised spans as a single text element
 * rather than splitting them into separate layers.
 */
function isTextual(childNodes: XscpNode[]): boolean {
  return childNodes.length > 0
    && childNodes.every((n) => n.text === true || n.type === 'LineBreak' || n.type === 'Span');
}

export function parseWebflow(data: XscpPayload, globalStyles?: GlobalStylesheet): ImportDocument {
  const nodes = data.payload?.nodes ?? [];
  const styles = data.payload?.styles ?? [];
  const assets = data.payload?.assets ?? [];

  const byId = new Map<string, XscpNode>();
  for (const node of nodes) byId.set(node._id, node);

  const resolvers = buildStyleResolvers(styles, assets, globalStyles);
  const resolveStyle = resolvers.byId;
  const resolveStyles = (classIds: string[] | undefined): ImportStyleRef[] =>
    (classIds ?? []).map(resolveStyle).filter((r): r is ImportStyleRef => r !== null);

  // Tag-rule classes from the global stylesheet (e.g. `h2` heading color),
  // memoised per tag. Empty when no stylesheet is supplied.
  const tagFrameworkCache = new Map<string, string[]>();
  const tagFramework = (tag?: string): string[] => {
    if (!tag || !globalStyles) return [];
    const key = tag.toLowerCase();
    const cached = tagFrameworkCache.get(key);
    if (cached) return cached;
    const decl = globalStyles.tagRules.get(key);
    const classes = decl ? cssToClasses(decl) : [];
    tagFrameworkCache.set(key, classes);
    return classes;
  };

  const ctx: WebflowParseContext = {
    byId,
    resolveStyle,
    resolveStyleByName: resolvers.byName,
    resolveStyles,
    resolveAssetUrl: resolvers.resolveAssetUrl,
    tagFramework,
    buildNode: (node) => buildNode(node, ctx),
  };

  // Roots = element nodes that are never referenced as someone's child.
  const childIds = new Set<string>();
  for (const node of nodes) {
    for (const childId of node.children ?? []) childIds.add(childId);
  }
  const roots = nodes
    .filter((n) => !childIds.has(n._id) && !n.text)
    .map((n) => buildNode(n, ctx))
    .filter((n): n is ImportNode => n !== null);

  // The site's base text style (`.body`: font-family, color, size) lives on the
  // <body>, which isn't in the clipboard. Apply it to the roots as lowest-
  // priority framework so the whole paste inherits the right typeface/colour.
  if (globalStyles?.bodyDecl) {
    const bodyClasses = cssToClasses(globalStyles.bodyDecl);
    if (bodyClasses.length > 0) {
      for (const root of roots) {
        root.frameworkClasses = [...bodyClasses, ...(root.frameworkClasses ?? [])];
      }
    }
  }

  const fontFamilies = new Set(extractFontFamilies(styles));
  for (const family of globalStyles?.fontFamilies ?? []) fontFamilies.add(family);
  const fonts = [...fontFamilies].map((family) => ({ family }));

  return { roots, fonts, source: 'Webflow' };
}

function buildNode(node: XscpNode | undefined, ctx: WebflowParseContext): ImportNode | null {
  if (!node) return null;

  // Bare text leaf surfacing as a root.
  if (node.text === true) {
    return { kind: 'text', text: node.v ?? '' };
  }

  const type = node.type;

  // Collection lists.
  if (isDynamoType(type)) {
    if (isCollectionWrapper(type)) return buildCollectionNode(node, ctx);
    return null; // list / item / empty consumed by the wrapper.
  }

  // Webflow built-in widget icons (slider arrows, chevrons, hamburger) carry a
  // named glyph from Webflow's icon font; map the common ones to inline SVG.
  if (type === 'Icon') {
    const svg = webflowIconSvg(node.data?.widget?.icon);
    if (!svg) return null;
    const iconStyles = resolveNodeStyles(node, ctx);
    const icon: ImportNode = { kind: 'icon', styles: iconStyles, svg };
    // Webflow icons inherit size from the widget's defaults (which aren't in the
    // clipboard), so give unstyled icons a sensible default box.
    if (iconStyles.length === 0) icon.classes = ['inline-block', 'w-6', 'h-6'];
    return icon;
  }

  // Inline SVGs (HtmlEmbed raw markup, or a rebuilt DOM <svg> tree). Without
  // this they collapse to empty boxes — e.g. social, arrow and chevron icons.
  const inlineSvg = extractInlineSvg(node, ctx);
  if (inlineSvg) {
    const svgStyles = resolveNodeStyles(node, ctx);
    return { kind: 'icon', styles: svgStyles, svg: inlineSvg, displayName: resolveDisplayName(node, svgStyles) };
  }

  const childNodes = (node.children ?? [])
    .map((id) => ctx.byId.get(id))
    .filter((n): n is XscpNode => n !== undefined);
  const styles = resolveNodeStyles(node, ctx);
  const displayName = resolveDisplayName(node, styles);

  if (type === 'Image') {
    return { kind: 'image', styles, image: imageFromNode(node, ctx.resolveAssetUrl), displayName };
  }

  if (type === 'Link') {
    const href = node.data?.link?.href || node.data?.attr?.href;
    const link = href ? { href } : undefined;
    const base: ImportNode = { kind: 'link', tag: 'a', styles, link, displayName };
    // Webflow buttons (`data.button`) rely on the framework's
    // `.w-button { display: inline-block }`, which isn't in the clipboard.
    // Flag them so they become Ycode `button` layers and seed the missing
    // display so they shrink-wrap instead of stretching inside a flex parent.
    const isButton = node.data?.button === true;
    const tagFw = ctx.tagFramework('a');
    if (isButton) {
      base.button = true;
      base.frameworkClasses = ['inline-block', ...tagFw];
    } else if (tagFw.length > 0) {
      base.frameworkClasses = tagFw;
    }
    if (isTextual(childNodes)) {
      base.text = collectText(childNodes, ctx);
    } else {
      base.children = childNodes.map((c) => buildNode(c, ctx)).filter((n): n is ImportNode => n !== null);
    }
    return base;
  }

  if (type === 'Heading') {
    const heading: ImportNode = { kind: 'heading', tag: node.tag, styles, text: collectText(childNodes, ctx), displayName };
    const tagFw = ctx.tagFramework(node.tag);
    if (tagFw.length > 0) heading.frameworkClasses = tagFw;
    return heading;
  }

  if (isTextual(childNodes)) {
    const textNode: ImportNode = { kind: 'text', tag: node.tag, styles, text: collectText(childNodes, ctx), displayName };
    const tagFw = ctx.tagFramework(node.tag);
    if (tagFw.length > 0) textNode.frameworkClasses = tagFw;
    return textNode;
  }

  const children = childNodes.map((c) => buildNode(c, ctx)).filter((n): n is ImportNode => n !== null);

  // Tabs show one pane at a time. The clipboard has no active-pane runtime, so
  // mirror Webflow's default view: keep the first pane visible, hide the rest.
  // The user reveals the others when they re-wire the tabs in Ycode.
  if (type === 'TabsContent') {
    children.forEach((pane, i) => {
      if (i > 0) pane.frameworkClasses = [...(pane.frameworkClasses ?? []), 'hidden'];
    });
  }

  const box: ImportNode = { kind: 'box', tag: node.tag, styles, displayName, children };
  const widgetClasses = type ? WEBFLOW_WIDGET_CLASSES[type] : undefined;
  const tagFw = ctx.tagFramework(node.tag);
  const framework = [...tagFw, ...(widgetClasses ?? [])];
  if (framework.length > 0) box.frameworkClasses = framework;
  return box;
}
