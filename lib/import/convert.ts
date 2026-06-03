/**
 * IR → Ycode `Layer[]` conversion.
 *
 * Walks the neutral `ImportNode` tree and produces real Ycode layers, creating
 * (and linking) shared `LayerStyle`s and re-hosting assets through the
 * materializer along the way.
 */

import type { Layer, LinkSettings } from '@/types';
import { generateId } from '@/lib/utils';
import { buildDesign } from '@/lib/import/design';
import { getAffectedProperties, removeConflictingClasses } from '@/lib/tailwind-class-mapper';
import type { ImportMaterializer } from '@/lib/import/materializer';
import type { ImportNode, ImportStyleRef } from '@/lib/import/types';

/** Breakpoint + state prefix on a Tailwind class (empty for base desktop/neutral). */
const CLASS_PREFIX_RE = /^((?:max-lg:|max-md:|lg:|md:)?(?:hover:|focus:|active:|disabled:|visited:|current:)?)/;

function classPrefix(cls: string): string {
  return cls.match(CLASS_PREFIX_RE)?.[1] ?? '';
}

/**
 * Collapse an ordered class stack (base first, combos/overrides last) into a
 * conflict-free list where later classes win per property — scoped to the same
 * breakpoint/state group.
 *
 * Webflow resolves a base class + combo classes by source order (the combo
 * wins). But stacking two utilities for the same property (e.g. base
 * `bg-[#f3f4f6]` and combo `bg-[#19292a]`) doesn't cascade by attribute order
 * in the compiled stylesheet, so the wrong one can win. We therefore drop the
 * earlier conflicting class, keeping the later one. Reuses Ycode's own
 * property-aware conflict detection, which (unlike tailwind-merge) correctly
 * separates background-color vs background-image, font-size vs text-color, etc.
 */
function mergeClassStack(orderedClasses: string[]): string[] {
  const merged: string[] = [];
  for (const cls of orderedClasses) {
    const props = getAffectedProperties(cls);
    if (props.length > 0) {
      const prefix = classPrefix(cls);
      for (let i = merged.length - 1; i >= 0; i -= 1) {
        if (classPrefix(merged[i]) !== prefix) continue;
        const conflicts = props.some((prop) => removeConflictingClasses([merged[i]], prop).length === 0);
        if (conflicts) merged.splice(i, 1);
      }
    }
    if (!merged.includes(cls)) merged.push(cls);
  }
  return merged;
}

/** Semantic tags that should be preserved via `settings.tag` on a div layer. */
const SEMANTIC_TAGS = new Set([
  'section', 'nav', 'header', 'footer', 'main', 'aside', 'article',
  'ul', 'ol', 'li', 'figure', 'figcaption', 'blockquote',
]);

interface ResolvedStyling {
  classes: string;
  design: Layer['design'];
  styleId?: string;
  styleOverrides?: Layer['styleOverrides'];
}

/** Build a Tiptap rich-text doc from plain text (newlines become hard breaks). */
function buildTextDoc(text: string): object {
  const parts = text.split('\n');
  const content: Array<Record<string, unknown>> = [];
  parts.forEach((part, i) => {
    if (i > 0) content.push({ type: 'hardBreak' });
    if (part) content.push({ type: 'text', text: part });
  });
  return { type: 'doc', content: [{ type: 'paragraph', content }] };
}

function makeRichTextVariable(text: string) {
  return { type: 'dynamic_rich_text' as const, data: { content: buildTextDoc(text) } };
}

export class ImportConverter {
  constructor(private readonly mat: ImportMaterializer) {}

  /** Convert a list of root nodes into Ycode layers. */
  async convertNodes(nodes: ImportNode[]): Promise<Layer[]> {
    const layers: Layer[] = [];
    for (const node of nodes) {
      const layer = await this.convertNode(node);
      if (layer) layers.push(layer);
    }
    return layers;
  }

  private async convertNode(node: ImportNode): Promise<Layer | null> {
    switch (node.kind) {
      case 'icon':
        return this.convertIcon(node);
      case 'image':
        return this.convertImage(node);
      case 'text':
      case 'heading':
        return this.convertText(node);
      case 'collection':
        return this.convertCollection(node);
      case 'link':
        return this.convertBox(node, true);
      case 'box':
      default:
        return this.convertBox(node, false);
    }
  }

  /**
   * Resolve a node's reusable styles + extra classes into a styled layer base.
   *
   * Webflow stacks multiple reusable classes on one element (base + combos), but
   * Ycode allows a single `styleId` per layer. So we collapse the whole class
   * stack into one reusable `LayerStyle`, deduped by the ordered stack identity.
   * Identical stacks across elements share the same style (real reuse), and no
   * `styleOverrides` are written unless a genuine one-off class is present —
   * which keeps layers from being flagged "Customized".
   */
  private async resolveStyling(node: ImportNode): Promise<ResolvedStyling> {
    const refs = node.styles ?? [];
    const extra = node.classes ?? [];
    // Widget layout defaults sit *under* the element's own styles, so they merge
    // in first and lose any per-property conflict to the user's classes.
    const framework = node.frameworkClasses ?? [];

    if (refs.length > 0) {
      // Base class first, then combos, preserving order so combo/later classes
      // win (matches Webflow precedence and Tailwind's last-wins resolution).
      const base = refs.find((r) => !r.combo) ?? refs[0];
      const combos = refs.filter((r) => r !== base);
      const ordered = [base, ...combos];

      const stackRef: ImportStyleRef = {
        // Fold framework defaults into the key so two nodes that share user
        // classes but differ in widget layout don't collapse to one style.
        key: [...(framework.length ? [`fw:${framework.join('+')}`] : []), ...ordered.map((r) => r.key)].join('|'),
        name: ordered.map((r) => r.name).join(' · '),
        // Framework first (lowest priority), then base + combos so later
        // declarations win per property.
        classes: mergeClassStack([...framework, ...ordered.flatMap((r) => r.classes)]),
      };

      const style = await this.mat.getOrCreateStyle(stackRef);
      if (style) {
        if (extra.length > 0) {
          // One-off classes override the shared style, so they merge in last.
          const full = mergeClassStack([...style.classes.split(/\s+/).filter(Boolean), ...extra]).join(' ');
          const design = buildDesign(full);
          return {
            classes: full,
            design,
            styleId: style.id,
            styleOverrides: { classes: full, design },
          };
        }
        return { classes: style.classes, design: style.design, styleId: style.id };
      }
    }

    // No reusable style (none present, or creation failed): inline everything,
    // framework defaults first so the user's classes still win conflicts.
    const all = mergeClassStack([...framework, ...refs.flatMap((r) => r.classes), ...extra]).join(' ').trim();
    return { classes: all, design: buildDesign(all) };
  }

  private applyStyling(layer: Layer, styling: ResolvedStyling): void {
    layer.classes = styling.classes;
    if (styling.design) layer.design = styling.design;
    if (styling.styleId) layer.styleId = styling.styleId;
    if (styling.styleOverrides) layer.styleOverrides = styling.styleOverrides;
  }

  private async convertBox(node: ImportNode, isLink: boolean): Promise<Layer> {
    const styling = await this.resolveStyling(node);
    const tag = node.tag?.toLowerCase();
    const name = node.button
      ? 'button'
      : tag === 'section' ? 'section' : tag === 'form' ? 'form' : 'div';

    const layer: Layer = { id: generateId('lyr'), name, classes: '' };
    this.applyStyling(layer, styling);

    if (node.displayName) layer.customName = node.displayName;

    if (tag && tag !== name && SEMANTIC_TAGS.has(tag)) {
      layer.settings = { ...layer.settings, tag };
    }

    if (isLink && node.link?.href) {
      const link: LinkSettings = {
        type: 'url',
        url: { type: 'dynamic_text', data: { content: node.link.href } },
      };
      if (node.link.target) link.target = node.link.target as LinkSettings['target'];
      if (node.link.rel) link.rel = node.link.rel;
      layer.variables = { ...layer.variables, link };
    }

    const children = node.children ? await this.convertNodes(node.children) : [];
    if (children.length > 0) {
      layer.children = children;
    } else if (node.text) {
      layer.children = [this.makeTextLayer(node.text)];
    } else {
      layer.children = [];
    }

    return layer;
  }

  private async convertText(node: ImportNode): Promise<Layer> {
    const styling = await this.resolveStyling(node);
    const isHeading = node.kind === 'heading';
    const layer: Layer = {
      id: generateId('lyr'),
      name: isHeading ? 'heading' : 'text',
      classes: '',
      restrictions: { editText: true },
      variables: { text: makeRichTextVariable(node.text ?? '') },
    };
    this.applyStyling(layer, styling);
    if (node.displayName) layer.customName = node.displayName;

    if (isHeading && node.tag && /^h[1-6]$/.test(node.tag)) {
      layer.settings = { ...layer.settings, tag: node.tag };
    }

    return layer;
  }

  private async convertImage(node: ImportNode): Promise<Layer> {
    const styling = await this.resolveStyling(node);
    const img = node.image ?? {};

    let assetId = img.assetId;
    if (!assetId && img.src) {
      assetId = (await this.mat.uploadAsset(img.src)) ?? undefined;
    }

    const src = assetId
      ? { type: 'asset' as const, data: { asset_id: assetId } }
      : { type: 'dynamic_text' as const, data: { content: img.src ?? '' } };

    const layer: Layer = {
      id: generateId('lyr'),
      name: 'image',
      classes: '',
      variables: {
        image: {
          src,
          alt: { type: 'dynamic_text', data: { content: img.alt ?? '' } },
        },
      },
    };
    this.applyStyling(layer, styling);
    if (node.displayName) layer.customName = node.displayName;

    if (img.width || img.height) {
      layer.attributes = {
        ...layer.attributes,
        ...(img.width ? { width: img.width } : {}),
        ...(img.height ? { height: img.height } : {}),
      };
    }

    return layer;
  }

  private async convertIcon(node: ImportNode): Promise<Layer | null> {
    if (!node.svg) return null;
    const styling = await this.resolveStyling(node);
    const layer: Layer = {
      id: generateId('lyr'),
      name: 'icon',
      classes: '',
      variables: { icon: { src: { type: 'static_text', data: { content: node.svg } } } },
    };
    this.applyStyling(layer, styling);
    if (node.displayName) layer.customName = node.displayName;
    return layer;
  }

  private async convertCollection(node: ImportNode): Promise<Layer> {
    const styling = await this.resolveStyling(node);
    const layer: Layer = {
      id: generateId('lyr'),
      name: 'div',
      classes: '',
      // Empty placeholder — the user re-links this to a real Ycode collection.
      variables: { collection: { id: '' } },
    };
    this.applyStyling(layer, styling);
    if (node.displayName) layer.customName = node.displayName;

    const template = node.children ? await this.convertNodes(node.children) : [];
    layer.children = template.length > 0
      ? template
      : [{ id: generateId('lyr'), name: 'div', classes: '', children: [] }];

    return layer;
  }

  private makeTextLayer(text: string): Layer {
    return {
      id: generateId('lyr'),
      name: 'text',
      classes: '',
      restrictions: { editText: true },
      variables: { text: makeRichTextVariable(text) },
    };
  }
}
