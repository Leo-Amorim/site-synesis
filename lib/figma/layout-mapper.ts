import type { LayoutDesign, SpacingDesign, SizingDesign, PositioningDesign } from '@/types';
import type { FigmaNode } from '@/lib/figma/types';

function px(value: number | undefined | null): string | undefined {
  if (value == null || value === 0) return undefined;
  return `${Math.round(value * 100) / 100}px`;
}

function pxOrZero(value: number): string {
  return `${Math.round(value * 100) / 100}px`;
}

export type ParentLayoutMode = 'NONE' | 'HORIZONTAL' | 'VERTICAL' | 'GRID';

/**
 * Map Figma layout to Ycode design properties.
 *
 * @param parentLayoutMode - The layout mode of this node's parent.
 *   Children of flex/grid parents should NOT be absolutely positioned;
 *   they participate in the parent's flow and only need sizing.
 */
export function mapLayout(node: FigmaNode, parentLayoutMode: ParentLayoutMode = 'NONE'): {
  layout?: LayoutDesign;
  spacing?: SpacingDesign;
  sizing?: SizingDesign;
  positioning?: PositioningDesign;
} {
  const result: {
    layout?: LayoutDesign;
    spacing?: SpacingDesign;
    sizing?: SizingDesign;
    positioning?: PositioningDesign;
  } = {};

  const hasOwnLayout = node.layout && node.layout.mode !== 'NONE';
  const parentIsAutoLayout = parentLayoutMode !== 'NONE';

  if (hasOwnLayout && node.layout) {
    result.layout = mapFlexOrGridLayout(node.layout);
    result.spacing = mapSpacing(node.layout);
  }

  if (parentIsAutoLayout) {
    result.sizing = mapChildSizing(node);
  } else if (!hasOwnLayout) {
    // Top-level node or child of a non-auto-layout parent: use fixed sizing
    // Only use absolute positioning for non-root nodes in free-form parents
    result.sizing = mapFixedSizing(node);
  } else {
    result.sizing = mapSizing(node);
  }

  return result;
}

function mapFlexOrGridLayout(layout: NonNullable<FigmaNode['layout']>): LayoutDesign {
  const result: LayoutDesign = { isActive: true };

  if (layout.mode === 'GRID') {
    result.display = 'Grid';
    if (layout.gridTemplateColumns) result.gridTemplateColumns = layout.gridTemplateColumns;
    if (layout.gridTemplateRows) result.gridTemplateRows = layout.gridTemplateRows;
    mapAlignment(layout, result);
    if (layout.gap) result.gap = pxOrZero(layout.gap);
    if (layout.counterAxisSpacing != null) {
      result.rowGap = pxOrZero(layout.counterAxisSpacing);
      result.gapMode = 'individual';
    }
    return result;
  }

  result.display = 'Flex';
  result.flexDirection = layout.mode === 'HORIZONTAL' ? 'row' : 'column';

  if (layout.wrap) result.flexWrap = 'wrap';

  mapAlignment(layout, result);

  if (layout.gap) result.gap = pxOrZero(layout.gap);

  if (layout.counterAxisSpacing != null) {
    const crossGapProp = layout.mode === 'HORIZONTAL' ? 'columnGap' : 'rowGap';
    result[crossGapProp] = pxOrZero(layout.counterAxisSpacing);
    result.gapMode = 'individual';
  }

  return result;
}

function mapAlignment(layout: NonNullable<FigmaNode['layout']>, result: LayoutDesign): void {
  const primaryMap: Record<string, string> = {
    MIN: 'flex-start',
    CENTER: 'center',
    MAX: 'flex-end',
    SPACE_BETWEEN: 'space-between',
  };

  const counterMap: Record<string, string> = {
    MIN: 'flex-start',
    CENTER: 'center',
    MAX: 'flex-end',
    BASELINE: 'baseline',
  };

  if (layout.primaryAlign && primaryMap[layout.primaryAlign]) {
    result.justifyContent = primaryMap[layout.primaryAlign];
  }

  if (layout.counterAlign && counterMap[layout.counterAlign]) {
    result.alignItems = counterMap[layout.counterAlign];
  }
}

function mapSpacing(layout: NonNullable<FigmaNode['layout']>): SpacingDesign | undefined {
  const hasAnyPadding =
    layout.paddingTop || layout.paddingRight || layout.paddingBottom || layout.paddingLeft;

  if (!hasAnyPadding) return undefined;

  const top = pxOrZero(layout.paddingTop);
  const right = pxOrZero(layout.paddingRight);
  const bottom = pxOrZero(layout.paddingBottom);
  const left = pxOrZero(layout.paddingLeft);

  const allEqual = top === right && right === bottom && bottom === left;

  if (allEqual) {
    return { isActive: true, padding: top, paddingMode: 'all' };
  }

  return {
    isActive: true,
    paddingTop: top,
    paddingRight: right,
    paddingBottom: bottom,
    paddingLeft: left,
    paddingMode: 'individual',
  };
}

/**
 * Sizing for a child inside an auto-layout (flex/grid) parent.
 * Uses layoutSizingHorizontal/Vertical to determine fill/hug/fixed behavior.
 * No absolute positioning — the parent's layout handles placement.
 */
function mapChildSizing(node: FigmaNode): SizingDesign | undefined {
  const result: SizingDesign = {};
  let hasValue = false;

  const hSizing = node.layoutSizingHorizontal;
  if (hSizing === 'FILL') {
    result.width = '100%';
    hasValue = true;
  } else if (hSizing === 'HUG') {
    result.width = 'fit-content';
    hasValue = true;
  } else if (hSizing === 'FIXED' && node.width) {
    result.width = pxOrZero(node.width);
    hasValue = true;
  } else if (node.width) {
    result.width = pxOrZero(node.width);
    hasValue = true;
  }

  const vSizing = node.layoutSizingVertical;
  if (vSizing === 'FILL') {
    result.height = '100%';
    hasValue = true;
  } else if (vSizing === 'HUG') {
    result.height = 'fit-content';
    hasValue = true;
  } else if (vSizing === 'FIXED' && node.height) {
    result.height = pxOrZero(node.height);
    hasValue = true;
  }

  const minW = px(node.minWidth);
  if (minW) { result.minWidth = minW; hasValue = true; }

  const maxW = px(node.maxWidth);
  if (maxW) { result.maxWidth = maxW; hasValue = true; }

  const minH = px(node.minHeight);
  if (minH) { result.minHeight = minH; hasValue = true; }

  const maxH = px(node.maxHeight);
  if (maxH) { result.maxHeight = maxH; hasValue = true; }

  if (node.clipsContent) {
    result.overflow = 'hidden';
    hasValue = true;
  }

  if (!hasValue) return undefined;

  result.isActive = true;
  return result;
}

/**
 * Sizing for nodes at the top level or in a parent without auto-layout.
 * Uses explicit width/height but no absolute positioning
 * (top-level imported nodes flow naturally in the Ycode body).
 */
function mapFixedSizing(node: FigmaNode): SizingDesign | undefined {
  const result: SizingDesign = {
    isActive: true,
    width: pxOrZero(node.width),
    height: pxOrZero(node.height),
  };

  const minW = px(node.minWidth);
  if (minW) result.minWidth = minW;

  const maxW = px(node.maxWidth);
  if (maxW) result.maxWidth = maxW;

  const minH = px(node.minHeight);
  if (minH) result.minHeight = minH;

  const maxH = px(node.maxHeight);
  if (maxH) result.maxHeight = maxH;

  if (node.clipsContent) result.overflow = 'hidden';

  return result;
}

function mapSizing(node: FigmaNode): SizingDesign | undefined {
  const result: SizingDesign = {};
  let hasValue = false;

  const hSizing = node.layoutSizingHorizontal;
  if (hSizing === 'FILL') {
    result.width = '100%';
    hasValue = true;
  } else if (hSizing === 'HUG') {
    result.width = 'fit-content';
    hasValue = true;
  } else if (hSizing === 'FIXED' && node.width) {
    result.width = pxOrZero(node.width);
    hasValue = true;
  }

  const vSizing = node.layoutSizingVertical;
  if (vSizing === 'FILL') {
    result.height = '100%';
    hasValue = true;
  } else if (vSizing === 'HUG') {
    result.height = 'fit-content';
    hasValue = true;
  } else if (vSizing === 'FIXED' && node.height) {
    result.height = pxOrZero(node.height);
    hasValue = true;
  }

  const minW = px(node.minWidth);
  if (minW) { result.minWidth = minW; hasValue = true; }

  const maxW = px(node.maxWidth);
  if (maxW) { result.maxWidth = maxW; hasValue = true; }

  const minH = px(node.minHeight);
  if (minH) { result.minHeight = minH; hasValue = true; }

  const maxH = px(node.maxHeight);
  if (maxH) { result.maxHeight = maxH; hasValue = true; }

  if (node.clipsContent) {
    result.overflow = 'hidden';
    hasValue = true;
  }

  if (!hasValue) return undefined;

  result.isActive = true;
  return result;
}
