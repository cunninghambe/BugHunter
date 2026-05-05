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

  it('V56.4.15 sentinel-wired kinds are all wired (SWEEP_AUDIT_2026-05-03 kinds promoted)', () => {
    const wiredKinds = new Set(DETECTOR_REGISTRY.filter(e => e.status === 'wired').map(e => e.kind));
    // All 33 formerly-deferred audit kinds are now sentinel-wired via calibration fixtures.
    expect(wiredKinds.has('excessive_re_renders')).toBe(true);
    expect(wiredKinds.has('unbounded_list_render')).toBe(true);
    expect(wiredKinds.has('oversized_bundle')).toBe(true);
    expect(wiredKinds.has('memory_leak_suspected')).toBe(true);
    expect(wiredKinds.has('memory_leak_attributed')).toBe(true);
    expect(wiredKinds.has('multi_user_inconsistent_snapshot')).toBe(true);
    expect(wiredKinds.has('clock_skew_token_invalid')).toBe(true);
    expect(wiredKinds.has('clock_overflow')).toBe(true);
    expect(wiredKinds.has('clock_dst_corruption')).toBe(true);
    expect(wiredKinds.has('clock_leap_day_failure')).toBe(true);
    expect(wiredKinds.has('clock_timezone_display')).toBe(true);
  });

  it('has 127 wired entries (V56.4.15: +33 sentinel-wired via calibration fixtures)', () => {
    const wired = DETECTOR_REGISTRY.filter(e => e.status === 'wired');
    expect(wired).toHaveLength(127);
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

    it('finds xss_stored as wired (V56.4.15: sentinel-wired via mixed-runtime-mini)', () => {
      const entry = lookupDetector('xss_stored');
      expect(entry?.status).toBe('wired');
    });

    it('finds seo_robots_blocking_crawl as wired', () => {
      const entry = lookupDetector('seo_robots_blocking_crawl');
      expect(entry?.status).toBe('wired');
    });

    it('finds drag_drop_failure as wired (V56.4.15: sentinel-wired via interaction-palette-mini)', () => {
      const entry = lookupDetector('drag_drop_failure');
      expect(entry?.status).toBe('wired');
    });
  });
});
