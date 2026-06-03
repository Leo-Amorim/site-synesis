'use client';

/**
 * Unified clipboard-paste importer.
 *
 * Intercepts the browser paste event and dispatches by source:
 *   1. Webflow XSCP payload   → shared import pipeline (`lib/import`)
 *   2. Figma plugin payload   → Figma converter (`lib/figma`)
 *   3. Anything else          → normal Ycode internal paste (`onNormalPaste`)
 *
 * Both design-tool branches produce `Layer[]` and hand them to the same
 * `insertLayers` callback, so insertion/placement logic lives in one place.
 *
 * Runs on the `paste` event (not keydown) so we can read `clipboardData`. The
 * Ycode canvas is a same-origin iframe, so a paste fired while focus is inside
 * it never reaches the top document — we therefore bind the handler to the top
 * document AND every same-origin iframe document, re-attaching as iframes load.
 */

import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import type { Layer } from '@/types';
import { useFontsStore } from '@/stores/useFontsStore';
import { YCODE_FIGMA_SIGNATURE, isYcodeFigmaPayload } from '@/lib/figma/types';
import type { YcodeFigmaPayload } from '@/lib/figma/types';
import { buildImport } from '@/lib/import';
import { isWebflowClipboard, parseWebflowClipboard } from '@/lib/import/adapters/webflow';
import { parseGlobalStylesheet, type GlobalStylesheet } from '@/lib/import/adapters/webflow/global-styles';
import type { ImportSummary } from '@/lib/import/types';

// EXPERIMENT: hard-coded published Webflow stylesheet so we can validate global
// style backfill (section background, text colours, heading colours, fonts)
// before building the per-site URL detection/storage flow.
const EXPERIMENT_WEBFLOW_CSS_URL =
  'https://cdn.prod.website-files.com/6a1ed0b072b68f131b8cd038/css/liams-dapper-site-aac62a.webflow.shared.333816452.css';

/** Best-effort fetch + parse of the site stylesheet via the server proxy. */
async function loadGlobalStylesheet(url: string): Promise<GlobalStylesheet | undefined> {
  try {
    const res = await fetch(`/ycode/api/apps/webflow/stylesheet?url=${encodeURIComponent(url)}`);
    if (!res.ok) return undefined;
    const json = await res.json();
    const css: string | undefined = json?.data?.css;
    if (!css) return undefined;
    return parseGlobalStylesheet(css);
  } catch (error) {
    console.warn('[useImportPaste] global stylesheet load failed:', error);
    return undefined;
  }
}

interface UseImportPasteOptions {
  enabled: boolean;
  /** Insert built layers using the host's placement rules. */
  insertLayers: (layers: Layer[]) => void;
  /** Fall back to Ycode's internal clipboard paste. */
  onNormalPaste: () => void;
}

interface FontResolution {
  /** Lowercased family names that resolve to an installed/built-in font. */
  available: Set<string>;
  /** Families newly installed from Google during this import. */
  installed: string[];
  /** Families we couldn't resolve — left unset so layers use the default font. */
  unavailable: string[];
}

/**
 * Resolve the fonts used by an imported design BEFORE conversion runs.
 *
 * Installs any family that exists on Google Fonts, and returns the set of
 * families that actually resolve to a usable font. Families that can't be
 * resolved are reported back so the converter can skip them (rather than
 * emitting a dangling `font-[...]` class that silently renders as the default)
 * and the user can be told which fonts need manual handling.
 */
async function resolveFonts(families: string[]): Promise<FontResolution> {
  const store = useFontsStore.getState();
  await store.loadFonts();
  await store.loadGoogleFontsCatalog();

  const catalog = useFontsStore.getState().googleFontsCatalog;
  const available = new Set<string>();
  const installed: string[] = [];
  const unavailable: string[] = [];

  for (const family of families) {
    if (useFontsStore.getState().getFontByFamily(family)) {
      available.add(family.toLowerCase());
      continue;
    }

    const match = catalog.find(
      (f) => f.family.toLowerCase() === family.toLowerCase()
    );

    if (match) {
      try {
        await useFontsStore.getState().addGoogleFont(match);
        available.add(family.toLowerCase());
        installed.push(family);
        continue;
      } catch {
        /* fall through to unavailable */
      }
    }

    unavailable.push(family);
  }

  return { available, installed, unavailable };
}

/**
 * Returns the parsed payload, the string `'truncated'` when Figma data is
 * present but unparseable (clipboard truncation on large selections), or null
 * when there's no Figma data at all.
 */
function extractFigmaPayload(clipboardData: DataTransfer): YcodeFigmaPayload | 'truncated' | null {
  let sawSignature = false;

  const html = clipboardData.getData('text/html');
  if (html) {
    const match = html.match(/data-ycode-figma="([^"]*)"/);
    if (match?.[1]) {
      sawSignature = true;
      try {
        const decoded = decodeURIComponent(match[1]);
        const parsed = JSON.parse(decoded);
        if (isYcodeFigmaPayload(parsed)) return parsed;
      } catch { /* not valid / truncated */ }
    }
  }

  const text = clipboardData.getData('text/plain');
  if (text?.includes(YCODE_FIGMA_SIGNATURE)) {
    sawSignature = true;
    try {
      const parsed = JSON.parse(text);
      if (isYcodeFigmaPayload(parsed)) return parsed;
    } catch { /* not valid / truncated */ }
  }

  return sawSignature ? 'truncated' : null;
}

/** Pull whichever clipboard MIME type might carry a Webflow XSCP payload. */
function readClipboardText(clipboardData: DataTransfer): string {
  return (
    clipboardData.getData('application/json') ||
    clipboardData.getData('text/plain') ||
    clipboardData.getData('text/html') ||
    ''
  );
}

function webflowSummaryMessage(summary: ImportSummary): string {
  const parts = [
    `${summary.layers} layer${summary.layers === 1 ? '' : 's'}`,
    summary.styles > 0 ? `${summary.styles} style${summary.styles === 1 ? '' : 's'}` : '',
    summary.components > 0 ? `${summary.components} component${summary.components === 1 ? '' : 's'}` : '',
    summary.assets > 0 ? `${summary.assets} image${summary.assets === 1 ? '' : 's'}` : '',
    summary.fonts > 0 ? `${summary.fonts} font${summary.fonts === 1 ? '' : 's'}` : '',
  ].filter(Boolean);
  return `Imported ${parts.join(', ')}`;
}

export function useImportPaste({
  enabled,
  insertLayers,
  onNormalPaste,
}: UseImportPasteOptions) {
  // Guards against a second paste landing while an import is still running.
  const isProcessingRef = useRef(false);

  const importWebflow = useCallback(async (text: string) => {
    isProcessingRef.current = true;
    const toastId = toast.loading('Importing from Webflow…');
    try {
      const globalStyles = await loadGlobalStylesheet(EXPERIMENT_WEBFLOW_CSS_URL);
      const document = parseWebflowClipboard(text, globalStyles);
      if (!document) {
        toast.error('Could not read the Webflow selection', { id: toastId });
        return;
      }

      const { layers, summary } = await buildImport(document);

      if (layers.length === 0) {
        toast.error('No layers found in the Webflow selection', { id: toastId });
        return;
      }

      insertLayers(layers);

      toast.success(webflowSummaryMessage(summary), {
        id: toastId,
        description: summary.collections > 0
          ? `${summary.collections} collection${summary.collections === 1 ? '' : 's'} to re-link to your CMS.`
          : undefined,
      });
    } catch (error) {
      console.error('[useImportPaste] Webflow import failed:', error);
      toast.error('Failed to import from Webflow', {
        id: toastId,
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      isProcessingRef.current = false;
    }
  }, [insertLayers]);

  const importFigma = useCallback(async (payload: YcodeFigmaPayload) => {
    isProcessingRef.current = true;
    const toastId = toast.loading('Importing from Figma...');
    try {
      const { convertFigmaToLayers, extractFontFamilies } = await import('@/lib/figma/converter');
      const { FigmaMaterializer } = await import('@/lib/figma/materializer');
      const { figmaDebug, figmaDebugStash } = await import('@/lib/figma/debug');

      // Stash the payload so a failed import can be inspected via
      // window.__ycodeFigmaLastPayload in the console.
      figmaDebugStash('LastPayload', payload);
      figmaDebug('payload received', { bytes: JSON.stringify(payload).length });

      // Resolve fonts first so the converter only assigns families it can
      // actually render. Unresolvable fonts are reported back to the user.
      const fontFamilies = extractFontFamilies(payload);
      let fonts: FontResolution = { available: new Set(), installed: [], unavailable: [] };
      if (fontFamilies.length > 0) {
        try {
          fonts = await resolveFonts(fontFamilies);
        } catch (err) {
          console.warn('[useImportPaste] font resolution error:', err);
        }
      }

      const materializer = new FigmaMaterializer();
      const layers = await convertFigmaToLayers(payload, materializer, fonts.available);

      if (layers.length === 0) {
        toast.error('No valid layers found in Figma data', { id: toastId });
        return;
      }

      insertLayers(layers);

      const { summary } = materializer;
      const detailParts: string[] = [];
      if (summary.components > 0) detailParts.push(`${summary.components} component${summary.components !== 1 ? 's' : ''}`);
      if (summary.layerStyles > 0) detailParts.push(`${summary.layerStyles} style${summary.layerStyles !== 1 ? 's' : ''}`);
      if (summary.colorVariables > 0) detailParts.push(`${summary.colorVariables} color variable${summary.colorVariables !== 1 ? 's' : ''}`);
      if (fonts.installed.length > 0) detailParts.push(`${fonts.installed.length} font${fonts.installed.length !== 1 ? 's' : ''}`);

      toast.success('Imported from Figma', {
        id: toastId,
        description: detailParts.length > 0 ? `Created ${detailParts.join(' · ')}` : undefined,
      });

      // Tell the user about fonts we couldn't resolve so they know why some
      // text uses the default font and can upload/replace them if needed.
      if (fonts.unavailable.length > 0) {
        const names = fonts.unavailable.join(', ');
        toast.warning(
          `Using default font for ${fonts.unavailable.length} unavailable font${fonts.unavailable.length !== 1 ? 's' : ''}`,
          {
            description: `Not on Google Fonts: ${names}. Upload them under Fonts to match the design.`,
          },
        );
      }
    } catch (error) {
      console.error('Figma import failed:', error);
      toast.error('Failed to import from Figma', {
        id: toastId,
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      isProcessingRef.current = false;
    }
  }, [insertLayers]);

  const handlePaste = useCallback((e: ClipboardEvent) => {
    if (!enabled || isProcessingRef.current || !e.clipboardData) return;

    // Don't hijack pastes into editable fields (inputs, text editor, etc.).
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return;
    }

    // 1. Webflow XSCP payload.
    const text = readClipboardText(e.clipboardData);
    if (text && isWebflowClipboard(text)) {
      e.preventDefault();
      e.stopPropagation();
      void importWebflow(text);
      return;
    }

    // 2. Figma plugin payload.
    const figma = extractFigmaPayload(e.clipboardData);
    if (figma === 'truncated') {
      e.preventDefault();
      console.error('[useImportPaste] Figma payload present but unparseable (likely truncated/too large)');
      toast.error('Figma data was incomplete', {
        description: 'The selection may be too large to copy. Try copying a smaller section or fewer frames.',
      });
      return;
    }
    if (figma) {
      e.preventDefault();
      e.stopPropagation();
      void importFigma(figma);
      return;
    }

    // 3. Normal Ycode internal paste.
    e.preventDefault();
    onNormalPaste();
  }, [enabled, importWebflow, importFigma, onNormalPaste]);

  useEffect(() => {
    if (!enabled) return;

    // Track documents we've already wired up so we don't double-bind.
    const bound = new WeakSet<Document>();
    const listener = handlePaste as EventListener;

    const bind = (doc: Document | null | undefined) => {
      if (!doc || bound.has(doc)) return;
      bound.add(doc);
      // Capture phase so we claim the event before canvas/editor handlers.
      doc.addEventListener('paste', listener, true);
    };

    bind(document);

    // Same-origin iframe documents (the canvas). Re-scan periodically and on
    // load so we cover late-mounting and reloading iframes.
    const bindIframes = () => {
      document.querySelectorAll('iframe').forEach((iframe) => {
        try {
          bind(iframe.contentDocument);
        } catch {
          /* cross-origin — not accessible, skip */
        }
        iframe.addEventListener('load', () => {
          try {
            bind(iframe.contentDocument);
          } catch {
            /* cross-origin */
          }
        });
      });
    };

    bindIframes();
    const interval = window.setInterval(bindIframes, 1500);

    return () => {
      window.clearInterval(interval);
      document.removeEventListener('paste', listener, true);
      document.querySelectorAll('iframe').forEach((iframe) => {
        try {
          iframe.contentDocument?.removeEventListener('paste', listener, true);
        } catch {
          /* cross-origin */
        }
      });
    };
  }, [enabled, handlePaste]);
}
