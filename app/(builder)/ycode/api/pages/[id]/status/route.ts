import { NextRequest } from 'next/server';
import {
  getPageById,
  setPagePublishable,
  deletePublishedPage,
  enrichDraftPagesWithPublishStatus,
} from '@/lib/repositories/pageRepository';
import { getRoutePathsForPages, invalidatePages } from '@/lib/services/cacheService';
import { isHomepage } from '@/lib/page-utils';
import type { StatusAction } from '@/lib/collection-field-utils';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * POST /ycode/api/pages/[id]/status
 *
 * Change a page's publish status in real time. Going live is intentionally not
 * supported here: a page can depend on components, layer styles, color
 * variables, fonts, assets and CMS data, so it must go live through the full
 * site publish which resolves the whole dependency graph.
 * - draft: set is_publishable=false, remove the live version + purge its cache
 * - stage: set is_publishable=true (goes live on the next site publish)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const { action } = (await request.json()) as { action: StatusAction };

    if (!['draft', 'stage'].includes(action)) {
      return noCache({ error: 'Invalid action. Must be draft or stage' }, 400);
    }

    const page = await getPageById(id, false);
    if (!page) {
      return noCache({ error: 'Page not found' }, 404);
    }

    // The homepage and error pages must always stay live
    if (isHomepage(page) || page.error_page !== null) {
      return noCache({ error: 'This page cannot be set to draft' }, 400);
    }

    // Both actions remove the live version; only the publishable flag differs.
    // Resolve routes before deletion so the cache can be purged.
    let routes: string[] = [];
    try {
      routes = await getRoutePathsForPages([id]);
    } catch {
      // Non-fatal
    }

    await deletePublishedPage(id);
    await setPagePublishable(id, action === 'stage');

    if (routes.length > 0) {
      try {
        await invalidatePages(routes);
      } catch {
        // Non-fatal
      }
    }

    const updated = await getPageById(id, false);
    const [enriched] = updated ? await enrichDraftPagesWithPublishStatus([updated]) : [null];

    return noCache({ data: enriched });
  } catch (error) {
    console.error('Error updating page status:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to update page status' },
      500
    );
  }
}
