/**
 * Integration smoke test: SEO corpus classifier produces all 6 SEO BugKinds.
 * Page inputs mirror what the browser would scrape from fixtures/seo-bad/* pages.
 */
import { describe, it, expect } from 'vitest';
import { classifySeoCorpus } from '../../src/classify/seo.js';
import type { SeoPageInput, SeoCorpusInput } from '../../src/classify/seo.js';
import type { BugKind } from '../../src/types.js';

const ALL_SEO_KINDS: BugKind[] = [
  'seo_title_missing',
  'seo_title_duplicate_across_routes',
  'seo_meta_description_missing',
  'seo_canonical_missing',
  'seo_h1_missing_or_multiple',
  'seo_robots_blocking_crawl',
];

const ORIGIN = 'http://localhost:3000';

describe('seo-smoke: all 6 SEO BugKinds emitted', () => {
  it('emits seo_title_missing from fixtures/seo-bad/no-title', () => {
    // index.html has no <title>
    const corpus: SeoCorpusInput = {
      pages: [{ pageRoute: '/no-title', title: null, metaDescription: 'A page without a title tag.', canonicalHref: null, h1Count: 1, metaRobots: null }],
      robotsTxt: null, origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_title_missing')).toBe(true);
  });

  it('emits seo_title_duplicate_across_routes from fixtures/seo-bad/duplicate-titles', () => {
    // index.html and about.html both have title "My App"
    const pages: SeoPageInput[] = [
      { pageRoute: '/', title: 'My App', metaDescription: 'Home page', canonicalHref: null, h1Count: 1, metaRobots: null },
      { pageRoute: '/about', title: 'My App', metaDescription: 'About page', canonicalHref: null, h1Count: 1, metaRobots: null },
    ];
    const result = classifySeoCorpus({ pages, robotsTxt: null, origin: ORIGIN });
    const dup = result.find(d => d.kind === 'seo_title_duplicate_across_routes');
    expect(dup).toBeDefined();
    expect(dup?.seoContext?.affectedRoutes).toContain('/');
    expect(dup?.seoContext?.affectedRoutes).toContain('/about');
  });

  it('emits seo_meta_description_missing from fixtures/seo-bad/no-meta-description', () => {
    const corpus: SeoCorpusInput = {
      pages: [{ pageRoute: '/no-meta-description', title: 'No Meta Description', metaDescription: null, canonicalHref: null, h1Count: 1, metaRobots: null }],
      robotsTxt: null, origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_meta_description_missing')).toBe(true);
  });

  it('emits seo_canonical_missing from fixtures/seo-bad/no-canonical', () => {
    // page-b.html has canonical, index.html does not
    const pages: SeoPageInput[] = [
      { pageRoute: '/', title: 'No Canonical (Page A)', metaDescription: 'Page A', canonicalHref: null, h1Count: 1, metaRobots: null },
      { pageRoute: '/page-b', title: 'Page B (Has Canonical)', metaDescription: 'Page B', canonicalHref: `${ORIGIN}/page-b`, h1Count: 1, metaRobots: null },
    ];
    const result = classifySeoCorpus({ pages, robotsTxt: null, origin: ORIGIN });
    const missing = result.filter(d => d.kind === 'seo_canonical_missing');
    expect(missing.some(d => d.pageRoute === '/')).toBe(true);
  });

  it('emits seo_h1_missing_or_multiple from fixtures/seo-bad/h1-issues', () => {
    // no-h1.html has 0 h1s; multiple-h1.html has 2
    const pages: SeoPageInput[] = [
      { pageRoute: '/no-h1', title: 'No H1', metaDescription: 'Page with no h1', canonicalHref: null, h1Count: 0, metaRobots: null },
      { pageRoute: '/multiple-h1', title: 'Multiple H1s', metaDescription: 'Multiple h1 elements', canonicalHref: null, h1Count: 2, metaRobots: null },
    ];
    const result = classifySeoCorpus({ pages, robotsTxt: null, origin: ORIGIN });
    const h1Issues = result.filter(d => d.kind === 'seo_h1_missing_or_multiple');
    expect(h1Issues).toHaveLength(2);
  });

  it('emits seo_robots_blocking_crawl from fixtures/seo-bad/robots-block', () => {
    // index.html has <meta name="robots" content="noindex, nofollow">
    const corpus: SeoCorpusInput = {
      pages: [{ pageRoute: '/robots-block', title: 'Robots Blocked', metaDescription: 'noindex page', canonicalHref: null, h1Count: 1, metaRobots: 'noindex, nofollow' }],
      robotsTxt: null, origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_robots_blocking_crawl')).toBe(true);
  });

  it('all 6 SEO BugKinds are emittable in a single corpus', () => {
    const pages: SeoPageInput[] = [
      // no title → seo_title_missing; null metaDescription → seo_meta_description_missing;
      // no canonical while /about has one → seo_canonical_missing;
      // h1Count=0 → seo_h1_missing_or_multiple; noindex → seo_robots_blocking_crawl
      { pageRoute: '/', title: null, metaDescription: null, canonicalHref: null, h1Count: 0, metaRobots: 'noindex' },
      // same null title as / after normalisation (both null → no duplicate group), but /about
      // shares 'Shared Title' with /contact → seo_title_duplicate_across_routes
      { pageRoute: '/about', title: 'Shared Title', metaDescription: 'About', canonicalHref: `${ORIGIN}/about`, h1Count: 2, metaRobots: null },
      { pageRoute: '/contact', title: 'Shared Title', metaDescription: 'Contact', canonicalHref: null, h1Count: 1, metaRobots: null },
    ];
    const result = classifySeoCorpus({ pages, robotsTxt: null, origin: ORIGIN });
    const emittedKinds = new Set(result.map(d => d.kind));
    for (const kind of ALL_SEO_KINDS) {
      expect(emittedKinds.has(kind), `Expected ${kind} to be emitted`).toBe(true);
    }
  });
});
