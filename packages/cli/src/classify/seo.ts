// SEO hygiene classifier — runs once per crawl corpus, not per-action.
// Emits 6 BugKinds from page DOM scrapes and robots.txt parsing.

import type { BugDetection } from '../types.js';

export type SeoPageInput = {
  pageRoute: string;
  title: string | null;
  metaDescription: string | null;
  canonicalHref: string | null;
  h1Count: number;
  metaRobots: string | null;
};

export type SeoCorpusInput = {
  pages: SeoPageInput[];
  robotsTxt: string | null;
  origin: string;
};

/**
 * Minimal robots.txt parser (no runtime dep).
 * Returns true if `User-agent: *` has a `Disallow: /` rule.
 */
function robotsTxtBlocksRoot(robotsTxt: string): boolean {
  const lines = robotsTxt.split('\n').map(l => l.trim());
  let inStarBlock = false;

  for (const line of lines) {
    if (line.toLowerCase().startsWith('user-agent:')) {
      const agent = line.slice('user-agent:'.length).trim();
      inStarBlock = agent === '*';
    } else if (inStarBlock && line.toLowerCase().startsWith('disallow:')) {
      const path = line.slice('disallow:'.length).trim();
      if (path === '/') return true;
    }
  }

  return false;
}

export function classifySeoCorpus(input: SeoCorpusInput): BugDetection[] {
  const { pages, robotsTxt, origin } = input;
  const detections: BugDetection[] = [];

  const homepageRoutes = new Set([`${origin}/`, origin, '/']);
  const robotsBlocksRoot = robotsTxt !== null && robotsTxtBlocksRoot(robotsTxt);

  // Does any page in the corpus have a canonical href?
  const anyPageHasCanonical = pages.some(p => p.canonicalHref !== null);

  // Per-page detections
  for (const page of pages) {
    const { pageRoute, title, metaDescription, canonicalHref, h1Count, metaRobots } = page;

    if (title === null || title.trim() === '') {
      detections.push({
        kind: 'seo_title_missing',
        rootCause: `Page "${pageRoute}" has no <title> element or the title is empty`,
        pageRoute,
        seoContext: { field: 'title', observedValue: title, expectedShape: 'non-empty string' },
      });
    }

    if (metaDescription === null || metaDescription.trim() === '') {
      detections.push({
        kind: 'seo_meta_description_missing',
        rootCause: `Page "${pageRoute}" is missing <meta name="description"> or its content is empty`,
        pageRoute,
        seoContext: { field: 'meta_description', observedValue: metaDescription, expectedShape: 'non-empty content attribute' },
      });
    }

    if (canonicalHref === null && anyPageHasCanonical) {
      detections.push({
        kind: 'seo_canonical_missing',
        rootCause: `Page "${pageRoute}" lacks <link rel="canonical"> while other pages in the corpus have one`,
        pageRoute,
        seoContext: { field: 'canonical', observedValue: null, expectedShape: '<link rel="canonical" href="...">' },
      });
    }

    if (h1Count !== 1) {
      detections.push({
        kind: 'seo_h1_missing_or_multiple',
        rootCause: `Page "${pageRoute}" has ${h1Count} <h1> element(s) — exactly 1 is required`,
        pageRoute,
        seoContext: {
          field: 'h1',
          observedValue: String(h1Count),
          expectedShape: 'exactly 1 <h1>',
        },
      });
    }

    if (metaRobots?.toLowerCase().includes('noindex') === true) {
      detections.push({
        kind: 'seo_robots_blocking_crawl',
        rootCause: `Page "${pageRoute}" has <meta name="robots" content="noindex"> but is reachable via crawl — site disagrees with itself`,
        pageRoute,
        seoContext: { field: 'robots_meta', observedValue: metaRobots, expectedShape: 'no noindex directive on crawlable pages' },
      });
    }

    if (robotsBlocksRoot && (homepageRoutes.has(pageRoute) || pageRoute === '/')) {
      detections.push({
        kind: 'seo_robots_blocking_crawl',
        rootCause: `robots.txt has "Disallow: /" for User-agent: * but the homepage is reachable via crawl`,
        pageRoute,
        seoContext: { field: 'robots_txt', observedValue: 'Disallow: /', expectedShape: 'Allow: / for crawlable pages' },
      });
    }
  }

  // Cross-page: duplicate titles
  const titleGroups = new Map<string, string[]>();
  for (const page of pages) {
    if (page.title !== null && page.title.trim() !== '') {
      const key = page.title.toLowerCase().trim();
      const group = titleGroups.get(key) ?? [];
      group.push(page.pageRoute);
      titleGroups.set(key, group);
    }
  }

  for (const [normalizedTitle, routes] of titleGroups) {
    if (routes.length > 1) {
      detections.push({
        kind: 'seo_title_duplicate_across_routes',
        rootCause: `Title "${normalizedTitle}" is shared across ${routes.length} distinct routes: ${routes.join(', ')}`,
        seoContext: {
          field: 'title',
          observedValue: normalizedTitle,
          expectedShape: 'unique title per route',
          affectedRoutes: routes,
        },
      });
    }
  }

  return detections;
}
