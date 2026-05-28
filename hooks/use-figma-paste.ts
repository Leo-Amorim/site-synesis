'use client';

/**
 * Unified Paste Hook
 *
 * Intercepts the browser paste event to:
 * 1. Check for Figma plugin clipboard data → convert and insert layers
 * 2. Fall back to normal Ycode internal clipboard paste
 *
 * This runs on the paste event (not keydown) so we have access to
 * clipboardData for detecting the Figma payload.
 */

import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { YCODE_FIGMA_SIGNATURE, isYcodeFigmaPayload } from '@/lib/figma/types';
import type { YcodeFigmaPayload } from '@/lib/figma/types';
import type { Layer } from '@/types';

interface UseFigmaPasteOptions {
  enabled: boolean;
  insertFigmaLayers: (layers: Layer[]) => void;
  onNormalPaste: () => void;
}

function extractFigmaPayload(clipboardData: DataTransfer): YcodeFigmaPayload | null {
  const html = clipboardData.getData('text/html');
  if (html) {
    const match = html.match(/data-ycode-figma="([^"]*)"/);
    if (match?.[1]) {
      try {
        const decoded = decodeURIComponent(match[1]);
        const parsed = JSON.parse(decoded);
        if (isYcodeFigmaPayload(parsed)) return parsed;
      } catch { /* not valid */ }
    }
  }

  const text = clipboardData.getData('text/plain');
  if (text?.includes(YCODE_FIGMA_SIGNATURE)) {
    try {
      const parsed = JSON.parse(text);
      if (isYcodeFigmaPayload(parsed)) return parsed;
    } catch { /* not valid */ }
  }

  return null;
}

export function useFigmaPaste({
  enabled,
  insertFigmaLayers,
  onNormalPaste,
}: UseFigmaPasteOptions) {
  const isProcessingRef = useRef(false);

  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    console.log('[FigmaPaste] paste event fired', {
      enabled,
      isProcessing: isProcessingRef.current,
      hasClipboardData: !!e.clipboardData,
      types: e.clipboardData?.types,
    });

    if (!enabled || isProcessingRef.current) {
      console.log('[FigmaPaste] skipped — enabled:', enabled, 'isProcessing:', isProcessingRef.current);
      return;
    }

    const target = e.target as HTMLElement;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      console.log('[FigmaPaste] skipped — input focused:', target.tagName);
      return;
    }

    e.preventDefault();

    if (!e.clipboardData) {
      console.log('[FigmaPaste] no clipboardData, falling through to normal paste');
      onNormalPaste();
      return;
    }

    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    console.log('[FigmaPaste] clipboard contents:', {
      htmlLength: html?.length,
      htmlPreview: html?.substring(0, 200),
      textLength: text?.length,
      textPreview: text?.substring(0, 200),
    });

    const payload = extractFigmaPayload(e.clipboardData);
    console.log('[FigmaPaste] extracted payload:', payload ? `${payload.nodes.length} nodes` : 'null');

    if (!payload) {
      console.log('[FigmaPaste] no Figma data found, falling through to normal paste');
      onNormalPaste();
      return;
    }

    isProcessingRef.current = true;

    const nodeCount = payload.nodes.length;
    const toastId = toast.loading(
      `Importing ${nodeCount} layer${nodeCount !== 1 ? 's' : ''} from Figma...`
    );

    try {
      const { convertFigmaToLayers } = await import('@/lib/figma/converter');
      const layers = await convertFigmaToLayers(payload);

      if (layers.length === 0) {
        toast.error('No valid layers found in Figma data', { id: toastId });
        return;
      }

      insertFigmaLayers(layers);

      toast.success(
        `Imported ${layers.length} layer${layers.length !== 1 ? 's' : ''} from Figma`,
        { id: toastId }
      );
    } catch (error) {
      console.error('Figma import failed:', error);
      toast.error('Failed to import from Figma', {
        id: toastId,
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      isProcessingRef.current = false;
    }
  }, [enabled, insertFigmaLayers, onNormalPaste]);

  useEffect(() => {
    if (!enabled) return;

    document.addEventListener('paste', handlePaste, true);
    return () => document.removeEventListener('paste', handlePaste, true);
  }, [enabled, handlePaste]);
}
