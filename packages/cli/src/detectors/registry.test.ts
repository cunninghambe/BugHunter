import { describe, it, expect } from 'vitest';
import { DETECTOR_REGISTRY, lookupDetector } from './registry.js';

describe('DETECTOR_REGISTRY', () => {
  it('has no duplicate kinds', () => {
    const kinds = DETECTOR_REGISTRY.map(e => e.kind);
    const unique = new Set(kinds);
    expect(unique.size).toBe(kinds.length);
  });

  it('has 127 entries covering all BugKinds', () => {
    expect(DETECTOR_REGISTRY.length).toBe(127);
  });

  it('deferred kinds include the 11 flipped in audit honesty pass (SWEEP_AUDIT_2026-05-03)', () => {
    const deferred = DETECTOR_REGISTRY.filter(e => e.status === 'deferred');
    expect(deferred.length).toBeGreaterThanOrEqual(33);
    const deferredKinds = new Set(deferred.map(e => e.kind));
    // 11 newly deferred from audit
    expect(deferredKinds.has('excessive_re_renders')).toBe(true);
    expect(deferredKinds.has('unbounded_list_render')).toBe(true);
    expect(deferredKinds.has('n_plus_one_api_calls')).toBe(true);
    expect(deferredKinds.has('request_dedup_missing')).toBe(true);
    expect(deferredKinds.has('request_cancellation_missing')).toBe(true);
    expect(deferredKinds.has('oversized_bundle')).toBe(true);
    expect(deferredKinds.has('memory_leak_suspected')).toBe(true);
    expect(deferredKinds.has('memory_leak_attributed')).toBe(true);
    expect(deferredKinds.has('interactive_element_missing_accessible_name')).toBe(true);
    expect(deferredKinds.has('multi_user_inconsistent_snapshot')).toBe(true);
    expect(deferredKinds.has('clock_skew_token_invalid')).toBe(true);
    expect(deferredKinds.has('clock_overflow')).toBe(true);
    expect(deferredKinds.has('clock_dst_corruption')).toBe(true);
    expect(deferredKinds.has('clock_leap_day_failure')).toBe(true);
    expect(deferredKinds.has('clock_timezone_display')).toBe(true);
  });

  it('has 90 wired entries (after audit honesty flip of 11 kinds, SWEEP_AUDIT_2026-05-03)', () => {
    const wired = DETECTOR_REGISTRY.filter(e => e.status === 'wired');
    expect(wired).toHaveLength(90);
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
