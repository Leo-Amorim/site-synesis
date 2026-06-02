'use client';

import { isHomepage } from '@/lib/page-utils';
import type { Page } from '@/types';

type PageStatus = 'draft' | 'staged' | 'published' | 'published-edited';

/** Derive a page's publish status from its draft flags and computed published state */
function getPageStatus(page: Page): PageStatus {
  if (page.is_publishable === false) return 'draft';
  if (page.has_published_version) return page.is_modified ? 'published-edited' : 'published';
  return 'staged';
}

export interface PageStatusAvailability {
  canStage: boolean;
  canDraft: boolean;
}

const NO_STATUS_ACTIONS: PageStatusAvailability = {
  canStage: false,
  canDraft: false,
};

/**
 * Which status actions make sense for a page given its current state. Going
 * live happens through the full site publish, so per-page actions only toggle
 * the publishable flag. The homepage and error pages must always stay live.
 */
export function getPageStatusAvailability(page: Page | null): PageStatusAvailability {
  if (!page) return NO_STATUS_ACTIONS;

  const status = getPageStatus(page);
  const isHome = isHomepage(page);

  return {
    // Only a draft page can be staged; staged/published pages can be set back to draft
    canStage: !isHome && status === 'draft',
    canDraft: !isHome && status !== 'draft',
  };
}
