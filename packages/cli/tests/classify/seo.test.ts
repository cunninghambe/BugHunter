import { describe, it, expect } from 'vitest';
import { classifySeoCorpus } from '../../src/classify/seo.js';
import type { SeoPageInput, SeoCorpusInput } from '../../src/classify/seo.js';

const ORIGIN = 'http://localhost:3000';

function makePage(overrides: Partial<SeoPageInput> & { pageRoute: string }): SeoPageInput {
  return {
    title: 'My App',
    metaDescription: 'A great app',
    canonicalHref: null,
    h1Count: 1,
    metaRobots: null,
    ...overrides,
  };
}

describe('classifySeoCorpus — title missing', () => {
  it('emits seo_title_missing when title is null', () => {
    const corpus: SeoCorpusInput = {
      pages: [makePage({ pageRoute: '/', title: null })],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_title_missing')).toBe(true);
  });

  it('emits seo_title_missing when title is empty string', () => {
    const corpus: SeoCorpusInput = {
      pages: [makePage({ pageRoute: '/', title: '   ' })],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_title_missing')).toBe(true);
  });

  it('does not emit seo_title_missing when title is present', () => {
    const corpus: SeoCorpusInput = {
      pages: [makePage({ pageRoute: '/' })],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_title_missing')).toBe(false);
  });
});

describe('classifySeoCorpus — duplicate titles', () => {
  it('emits seo_title_duplicate_across_routes when two routes share a title', () => {
    const corpus: SeoCorpusInput = {
      pages: [
        makePage({ pageRoute: '/', title: 'My App' }),
        makePage({ pageRoute: '/about', title: 'My App' }),
      ],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    const dup = result.find(d => d.kind === 'seo_title_duplicate_across_routes');
    expect(dup).toBeDefined();
    expect(dup?.seoContext?.affectedRoutes).toHaveLength(2);
    expect(dup?.seoContext?.affectedRoutes).toContain('/');
    expect(dup?.seoContext?.affectedRoutes).toContain('/about');
  });

  it('treats titles case-insensitively', () => {
    const corpus: SeoCorpusInput = {
      pages: [
        makePage({ pageRoute: '/', title: 'My App' }),
        makePage({ pageRoute: '/about', title: 'MY APP' }),
      ],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_title_duplicate_across_routes')).toBe(true);
  });

  it('does not emit duplicate when titles are distinct', () => {
    const corpus: SeoCorpusInput = {
      pages: [
        makePage({ pageRoute: '/', title: 'Home' }),
        makePage({ pageRoute: '/about', title: 'About' }),
      ],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_title_duplicate_across_routes')).toBe(false);
  });
});

describe('classifySeoCorpus — meta description', () => {
  it('emits seo_meta_description_missing when metaDescription is null', () => {
    const corpus: SeoCorpusInput = {
      pages: [makePage({ pageRoute: '/', metaDescription: null })],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_meta_description_missing')).toBe(true);
  });
});

describe('classifySeoCorpus — canonical missing', () => {
  it('emits seo_canonical_missing only when a peer page has canonical', () => {
    const corpus: SeoCorpusInput = {
      pages: [
        makePage({ pageRoute: '/', canonicalHref: null }),
        makePage({ pageRoute: '/about', canonicalHref: 'http://localhost:3000/about' }),
      ],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    const missing = result.filter(d => d.kind === 'seo_canonical_missing');
    expect(missing).toHaveLength(1);
    expect(missing[0].pageRoute).toBe('/');
  });

  it('suppresses seo_canonical_missing when no page has canonical', () => {
    const corpus: SeoCorpusInput = {
      pages: [
        makePage({ pageRoute: '/', canonicalHref: null }),
        makePage({ pageRoute: '/about', canonicalHref: null }),
      ],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_canonical_missing')).toBe(false);
  });
});

describe('classifySeoCorpus — h1', () => {
  it('emits seo_h1_missing_or_multiple when h1Count is 0', () => {
    const corpus: SeoCorpusInput = {
      pages: [makePage({ pageRoute: '/', h1Count: 0 })],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_h1_missing_or_multiple')).toBe(true);
  });

  it('emits seo_h1_missing_or_multiple when h1Count is 2', () => {
    const corpus: SeoCorpusInput = {
      pages: [makePage({ pageRoute: '/', h1Count: 2 })],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_h1_missing_or_multiple')).toBe(true);
  });
});

describe('classifySeoCorpus — robots blocking crawl', () => {
  it('emits seo_robots_blocking_crawl for noindex meta on crawlable page', () => {
    const corpus: SeoCorpusInput = {
      pages: [makePage({ pageRoute: '/dashboard', metaRobots: 'noindex, nofollow' })],
      robotsTxt: null,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_robots_blocking_crawl')).toBe(true);
  });

  it('emits seo_robots_blocking_crawl when robots.txt has Disallow: / for homepage', () => {
    const robotsTxt = 'User-agent: *\nDisallow: /\n';
    const corpus: SeoCorpusInput = {
      pages: [makePage({ pageRoute: '/' })],
      robotsTxt,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_robots_blocking_crawl')).toBe(true);
  });

  it('does not emit seo_robots_blocking_crawl when robots.txt allows root', () => {
    const robotsTxt = 'User-agent: *\nDisallow: /private\n';
    const corpus: SeoCorpusInput = {
      pages: [makePage({ pageRoute: '/' })],
      robotsTxt,
      origin: ORIGIN,
    };
    const result = classifySeoCorpus(corpus);
    expect(result.some(d => d.kind === 'seo_robots_blocking_crawl')).toBe(false);
  });
});
