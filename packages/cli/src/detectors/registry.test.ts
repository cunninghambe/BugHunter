import { describe, it, expect } from 'vitest';
import { DETECTOR_REGISTRY, lookupDetector } from './registry.js';

describe('DETECTOR_REGISTRY', () => {
  it('has no duplicate kinds', () => {
    const kinds = DETECTOR_REGISTRY.map(e => e.kind);
    const unique = new Set(kinds);
    expect(unique.size).toBe(kinds.length);
  });

  it('has 122 entries covering all BugKinds (v0.38: +9 interaction-palette wired)', () => {
    expect(DETECTOR_REGISTRY.length).toBe(122);
  });

  it('has exactly 1 deferred entry (xss_stored)', () => {
    const deferred = DETECTOR_REGISTRY.filter(e => e.status === 'deferred');
    expect(deferred).toHaveLength(1);
    const deferredKinds = deferred.map(e => e.kind).sort();
    expect(deferredKinds).toEqual([
      'xss_stored',
    ]);
  });

  it('has 121 wired entries (v0.38: +9 interaction-palette)', () => {
    const wired = DETECTOR_REGISTRY.filter(e => e.status === 'wired');
    expect(wired).toHaveLength(121);
  });

  it('has 0 dead entries', () => {
    const dead = DETECTOR_REGISTRY.filter(e => e.status === 'dead');
    expect(dead).toHaveLength(0);
  });

  it('all wired entries have a detectorSite', () => {
    const wiredMissingDetectorSite = DETECTOR_REGISTRY
      .filter(e => e.status === 'wired' && e.detectorSite === undefined);
    expect(wiredMissingDetectorSite).toHaveLength(0);
  });

  it('all deferred entries have a note explaining why', () => {
    const deferredMissingNote = DETECTOR_REGISTRY
      .filter(e => e.status === 'deferred' && (e.note === undefined || e.note === ''));
    expect(deferredMissingNote).toHaveLength(0);
  });

  it('all entries have a valid inputSource', () => {
    const valid = new Set(['production', 'synthetic-only', 'unknown']);
    const invalid = DETECTOR_REGISTRY.filter(e => !valid.has(e.inputSource));
    expect(invalid).toHaveLength(0);
  });

  it('all entries have a specReference', () => {
    const missing = DETECTOR_REGISTRY.filter(e => !e.specReference);
    expect(missing).toHaveLength(0);
  });

  describe('lookupDetector', () => {
    it('finds console_error with correct detectorSite', () => {
      const entry = lookupDetector('console_error');
      expect(entry).toBeDefined();
      expect(entry?.detectorSite).toBe('packages/cli/src/classify/console.ts:24');
    });

    it('finds csrf_missing_on_mutating_route as wired', () => {
      const entry = lookupDetector('csrf_missing_on_mutating_route');
      expect(entry?.status).toBe('wired');
    });

    it('finds xss_stored as deferred', () => {
      const entry = lookupDetector('xss_stored');
      expect(entry?.status).toBe('deferred');
    });

    it('finds seo_robots_blocking_crawl as wired', () => {
      const entry = lookupDetector('seo_robots_blocking_crawl');
      expect(entry?.status).toBe('wired');
    });

    it('finds drag_drop_failure as deferred', () => {
      const entry = lookupDetector('drag_drop_failure');
      expect(entry?.status).toBe('deferred');
    });
  });
});
