'use client';

import type { Layer, DesignProperties } from '@/types';
import type { YcodeFigmaPayload, FigmaNode, FigmaNodeType } from '@/lib/figma/types';
import { generateId } from '@/lib/utils';
import { designToClassString } from '@/lib/tailwind-class-mapper';
import { mapLayout } from '@/lib/figma/layout-mapper';
import type { ParentLayoutMode } from '@/lib/figma/layout-mapper';
import { mapDesign } from '@/lib/figma/design-mapper';
import { mapText } from '@/lib/figma/text-mapper';
import { uploadFigmaImage, uploadFigmaSvg } from '@/lib/figma/image-handler';

const CONTAINER_TYPES: Set<FigmaNodeType> = new Set([
  'FRAME', 'GROUP', 'SECTION', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE',
]);

const VECTOR_TYPES: Set<FigmaNodeType> = new Set([
  'VECTOR', 'BOOLEAN_OPERATION', 'LINE', 'STAR', 'REGULAR_POLYGON',
]);

function getLayerName(node: FigmaNode): string {
  if (node.type === 'TEXT') return 'text';
  return 'div';
}

function sanitizeCustomName(name: string): string {
  return name.trim().slice(0, 100);
}

function getNodeLayoutMode(node: FigmaNode): ParentLayoutMode {
  return node.layout?.mode ?? 'NONE';
}

async function convertNode(node: FigmaNode, parentLayoutMode: ParentLayoutMode = 'NONE'): Promise<Layer> {
  const id = generateId('lyr');
  const design: DesignProperties = {};

  const { layout, spacing, sizing, positioning } = mapLayout(node, parentLayoutMode);
  if (layout) design.layout = layout;
  if (spacing) design.spacing = spacing;
  if (sizing) design.sizing = sizing;
  if (positioning) design.positioning = positioning;

  const { backgrounds, borders, effects } = mapDesign(node);
  if (backgrounds) design.backgrounds = backgrounds;
  if (borders) design.borders = borders;
  if (effects) design.effects = effects;

  if (node.opacity < 1) {
    design.effects = {
      ...design.effects,
      isActive: true,
      opacity: String(Math.round(node.opacity * 100) / 100),
    };
  }

  const layerName = getLayerName(node);
  const layer: Layer = {
    id,
    name: layerName,
    customName: sanitizeCustomName(node.name),
    classes: '',
    design,
  };

  if (node.type === 'TEXT' && node.text) {
    const { typography, tiptapContent } = mapText(node.text);
    design.typography = typography;
    layer.variables = {
      text: {
        type: 'dynamic_rich_text',
        data: { content: tiptapContent },
      },
    };
    layer.restrictions = { editText: true };
  }

  if (node.imageData) {
    const filename = `${node.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.png`;
    const assetId = await uploadFigmaImage(node.imageData, filename);

    if (assetId) {
      const hasImageFill = node.fills.some((f) => f.type === 'IMAGE' && f.visible);
      if (hasImageFill || VECTOR_TYPES.has(node.type)) {
        layer.name = 'image';
        layer.variables = {
          ...layer.variables,
          image: {
            src: { type: 'asset', data: { asset_id: assetId } },
            alt: { type: 'dynamic_text', data: { content: node.name } },
          },
        };
      } else {
        layer.variables = {
          ...layer.variables,
          backgroundImage: {
            src: { type: 'asset', data: { asset_id: assetId } },
          },
        };
      }
    }
  }

  if (node.svgData) {
    const filename = `${node.name.replace(/[^a-zA-Z0-9_-]/g, '_')}.svg`;
    const assetId = await uploadFigmaSvg(node.svgData, filename);

    if (assetId) {
      layer.name = 'image';
      layer.variables = {
        ...layer.variables,
        image: {
          src: { type: 'asset', data: { asset_id: assetId } },
          alt: { type: 'dynamic_text', data: { content: node.name } },
        },
      };
    }
  }

  // Determine this node's layout mode so children know their parent context
  const thisLayoutMode = getNodeLayoutMode(node);

  if (CONTAINER_TYPES.has(node.type) || node.type === 'RECTANGLE' || node.type === 'ELLIPSE') {
    layer.children = [];
    if (node.children?.length) {
      const childLayers = await Promise.all(
        node.children.map((child) => convertNode(child, thisLayoutMode))
      );
      layer.children = childLayers;
    }
  }

  layer.classes = designToClassString(design);

  console.log(`[FigmaConvert] ${node.type} "${node.name}" (parent: ${parentLayoutMode})`, {
    classes: layer.classes,
  });

  if (!node.visible) {
    layer.settings = { ...layer.settings, hidden: true };
  }

  return layer;
}

export async function convertFigmaToLayers(payload: YcodeFigmaPayload): Promise<Layer[]> {
  console.log('[FigmaConvert] payload:', payload.nodes.length, 'nodes');
  // Top-level nodes have no parent layout — they'll be inserted into Ycode's body
  const layers = await Promise.all(
    payload.nodes.map((node) => convertNode(node, 'NONE'))
  );
  return layers;
}
