import { NextRequest } from 'next/server';
import { noCache } from '@/lib/api-response';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * GET /ycode/api/apps/webflow/stylesheet?url=<published .css URL>
 *
 * Server-side proxy for a Webflow site's published stylesheet. Fetching it
 * directly from the builder would hit CORS; routing through the server avoids
 * that (and lets us cache later). Restricted to Webflow's asset host to avoid
 * being used as an open proxy.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl.searchParams.get('url');

  if (!url) {
    return noCache({ error: 'Missing url parameter' }, 400);
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return noCache({ error: 'Invalid url' }, 400);
  }

  const hostAllowed =
    parsed.protocol === 'https:' &&
    /(^|\.)website-files\.com$/.test(parsed.hostname);

  if (!hostAllowed) {
    return noCache({ error: 'Only Webflow website-files.com stylesheets are allowed' }, 400);
  }

  try {
    const res = await fetch(parsed.toString(), { redirect: 'follow' });
    if (!res.ok) {
      return noCache({ error: `Upstream returned ${res.status}` }, 502);
    }
    const css = await res.text();
    return noCache({ data: { css } });
  } catch (error) {
    console.error('Error fetching Webflow stylesheet:', error);
    return noCache(
      { error: error instanceof Error ? error.message : 'Failed to fetch stylesheet' },
      500,
    );
  }
}
