// Unit tests for browser-platform-probe classify + helpers (v0.36).
// Tests only the pure classifyBrowserPlatform function — no I/O.

import { describe, it, expect } from 'vitest';
import { classifyBrowserPlatform } from './browser-platform-probe.js';
import type { BrowserPlatformProbeOpts } from './browser-platform-probe.js';

const BASE_OPTS: BrowserPlatformProbeOpts = {
  pageRoute: '/test',
  swStaleThresholdMs: 60_000,
  observationWindowMs: 2_000,
  permissions: ['geolocation'],
  enableShadowA11y: false,
  enableForcedPermissionDeny: false,
};

// Minimal valid envelope with all fields set to "clean" state.
function makeEnvelope(overrides: Record<string, unknown> = {}): Parameters<typeof classifyBrowserPlatform>[0] {
  return {
    pageRoute: '/test',
    bootInstalledAt: 1000,
    harvestedAt: 3000,
    sw: {
      registrations: [],
      controllerChangedDuringWindow: false,
    },
    workers: { errors: [] },
    postmessage: {
      listenerCount: 0,
      handlerSources: [],
    },
    webrtc: { connections: [] },
    sri: {
      blocked: [],
      scriptsWithIntegrity: 3,
      uiErrorVisible: false,
    },
    isolation: {
      crossOriginIsolated: false,
      sabReferenced: false,
      sabInstantiated: false,
    },
    trustedTypes: { violations: [] },
    shadowHosts: [],
    permissions: {},
    ...overrides,
  } as unknown as Parameters<typeof classifyBrowserPlatform>[0];
}

describe('classifyBrowserPlatform', () => {
  it('returns no detections for a clean envelope', () => {
    const detections = classifyBrowserPlatform(makeEnvelope(), BASE_OPTS);
    expect(detections).toHaveLength(0);
  });

  describe('service_worker_stale', () => {
    it('fires when SW is in waiting state past threshold on second visit', () => {
      const envelope = makeEnvelope({
        sw: {
          registrations: [
            {
              scope: '/app/',
              state: 'waiting',
              controllerUrl: null,
              ageMs: 120_000,
              isFirstVisit: false,
            },
          ],
          controllerChangedDuringWindow: false,
        },
      });
      const detections = classifyBrowserPlatform(envelope, BASE_OPTS);
      expect(detections).toHaveLength(1);
      expect(detections[0].kind).toBe('service_worker_stale');
      const ctx = detections[0].browserPlatformContext;
      expect(ctx?.kind).toBe('sw');
      if (ctx?.kind === 'sw') {
        expect(ctx.scope).toBe('/app/');
        expect(ctx.hasWaiting).toBe(true);
        expect(ctx.hasInstalling).toBe(false);
        expect(ctx.ageMs).toBe(120_000);
      }
    });

    it('does NOT fire on first visit', () => {
      const envelope = makeEnvelope({
        sw: {
          registrations: [
            {
              scope: '/app/',
              state: 'waiting',
              controllerUrl: null,
              ageMs: 120_000,
              isFirstVisit: true,
            },
          ],
          controllerChangedDuringWindow: false,
        },
      });
      expect(classifyBrowserPlatform(envelope, BASE_OPTS)).toHaveLength(0);
    });

    it('does NOT fire when ageMs is below threshold', () => {
      const envelope = makeEnvelope({
        sw: {
          registrations: [
            {
              scope: '/app/',
              state: 'waiting',
              controllerUrl: null,
              ageMs: 5_000,
              isFirstVisit: false,
            },
          ],
          controllerChangedDuringWindow: false,
        },
      });
      expect(classifyBrowserPlatform(envelope, BASE_OPTS)).toHaveLength(0);
    });

    it('does NOT fire when controllerChangedDuringWindow', () => {
      const envelope = makeEnvelope({
        sw: {
          registrations: [
            {
              scope: '/app/',
              state: 'waiting',
              controllerUrl: null,
              ageMs: 120_000,
              isFirstVisit: false,
            },
          ],
          controllerChangedDuringWindow: true,
        },
      });
      expect(classifyBrowserPlatform(envelope, BASE_OPTS)).toHaveLength(0);
    });
  });

  describe('web_worker_error', () => {
    it('fires for each unique worker error', () => {
      const envelope = makeEnvelope({
        workers: {
          errors: [
            { scriptUrl: '/worker.js', kind: 'error', errorMsg: 'SyntaxError: Unexpected token' },
            { scriptUrl: '/worker.js', kind: 'error', errorMsg: 'SyntaxError: Unexpected token' },
            { scriptUrl: '/other-worker.js', kind: 'messageerror', errorMsg: 'serialization failed' },
          ],
        },
      });
      const detections = classifyBrowserPlatform(envelope, BASE_OPTS);
      // Dedupes by scriptUrl+kind — 2 unique
      expect(detections).toHaveLength(2);
      expect(detections.every(d => d.kind === 'web_worker_error')).toBe(true);
    });

    it('captures eventKind in context', () => {
      const envelope = makeEnvelope({
        workers: {
          errors: [
            { scriptUrl: '/worker.js', kind: 'messageerror', errorMsg: 'deserialization failed' },
          ],
        },
      });
      const detections = classifyBrowserPlatform(envelope, BASE_OPTS);
      expect(detections).toHaveLength(1);
      const ctx = detections[0].browserPlatformContext;
      expect(ctx?.kind).toBe('worker');
      if (ctx?.kind === 'worker') {
        expect(ctx.eventKind).toBe('messageerror');
      }
    });
  });

  describe('iframe_postmessage_unguarded', () => {
    it('fires when handlers have no origin guard', () => {
      const envelope = makeEnvelope({
        postmessage: {
          listenerCount: 2,
          handlerSources: [
            'function(e) { handleMessage(e.data); }',
            'function(event) { process(event.data); }',
          ],
        },
      });
      const detections = classifyBrowserPlatform(envelope, BASE_OPTS);
      expect(detections).toHaveLength(1);
      expect(detections[0].kind).toBe('iframe_postmessage_unguarded');
      const ctx = detections[0].browserPlatformContext;
      expect(ctx?.kind).toBe('iframe');
      if (ctx?.kind === 'iframe') {
        expect(ctx.listenerCount).toBe(2);
        expect(ctx.handlerFingerprints).toHaveLength(2);
      }
    });

    it('does NOT fire when all handlers check event.origin', () => {
      const envelope = makeEnvelope({
        postmessage: {
          listenerCount: 1,
          handlerSources: [
            'function(event) { if (event.origin !== "https://trusted.example.com") return; handle(event.data); }',
          ],
        },
      });
      expect(classifyBrowserPlatform(envelope, BASE_OPTS)).toHaveLength(0);
    });

    it('does NOT fire with zero listeners', () => {
      const envelope = makeEnvelope({
        postmessage: { listenerCount: 0, handlerSources: [] },
      });
      expect(classifyBrowserPlatform(envelope, BASE_OPTS)).toHaveLength(0);
    });
  });

  describe('webrtc_ice_failure', () => {
    it('fires when connection is failed with no handler', () => {
      const envelope = makeEnvelope({
        webrtc: {
          connections: [
            { connectionId: 'conn-1', finalState: 'failed', hadHandler: false },
          ],
        },
      });
      const detections = classifyBrowserPlatform(envelope, BASE_OPTS);
      expect(detections).toHaveLength(1);
      expect(detections[0].kind).toBe('webrtc_ice_failure');
    });

    it('does NOT fire when handler is registered', () => {
      const envelope = makeEnvelope({
        webrtc: {
          connections: [
            { connectionId: 'conn-1', finalState: 'failed', hadHandler: true },
          ],
        },
      });
      expect(classifyBrowserPlatform(envelope, BASE_OPTS)).toHaveLength(0);
    });

    it('does NOT fire for non-failed state', () => {
      const envelope = makeEnvelope({
        webrtc: {
          connections: [
            { connectionId: 'conn-1', finalState: 'connected', hadHandler: false },
          ],
        },
      });
      expect(classifyBrowserPlatform(envelope, BASE_OPTS)).toHaveLength(0);
    });
  });

  describe('subresource_integrity_violation', () => {
    it('fires when a script is blocked and no error UI shown', () => {
      const envelope = makeEnvelope({
        sri: {
          blocked: [{ url: 'https://cdn.example.com/lib.js' }],
          scriptsWithIntegrity: 1,
          uiErrorVisible: false,
        },
      });
      const detections = classifyBrowserPlatform(envelope, BASE_OPTS);
      expect(detections).toHaveLength(1);
      expect(detections[0].kind).toBe('subresource_integrity_violation');
    });

    it('does NOT fire when no scripts are blocked', () => {
      const envelope = makeEnvelope({
        sri: { blocked: [], scriptsWithIntegrity: 2, uiErrorVisible: false },
      });
      expect(classifyBrowserPlatform(envelope, BASE_OPTS)).toHaveLength(0);
    });
  });

  describe('coop_coep_violation', () => {
    it('fires when crossOriginIsolated is false but SAB is referenced', () => {
      const envelope = makeEnvelope({
        isolation: { crossOriginIsolated: false, sabReferenced: true, sabInstantiated: false },
      });
      const detections = classifyBrowserPlatform(envelope, BASE_OPTS);
      expect(detections).toHaveLength(1);
      expect(detections[0].kind).toBe('coop_coep_violation');
    });

    it('fires when crossOriginIsolated is false but SAB is instantiated', () => {
      const envelope = makeEnvelope({
        isolation: { crossOriginIsolated: false, sabReferenced: false, sabInstantiated: true },
      });
      const detections = classifyBrowserPlatform(envelope, BASE_OPTS);
      expect(detections).toHaveLength(1);
    });

    it('does NOT fire when crossOriginIsolated is true', () => {
      const envelope = makeEnvelope({
        isolation: { crossOriginIsolated: true, sabReferenced: true, sabInstantiated: true },
      });
      expect(classifyBrowserPlatform(envelope, BASE_OPTS)).toHaveLength(0);
    });

    it('does NOT fire when neither SAB ref nor instantiation', () => {
      const envelope = makeEnvelope({
        isolation: { crossOriginIsolated: false, sabReferenced: false, sabInstantiated: false },
      });
      expect(classifyBrowserPlatform(envelope, BASE_OPTS)).toHaveLength(0);
    });
  });

  describe('trusted_types_violation', () => {
    it('fires for each violation', () => {
      const envelope = makeEnvelope({
        trustedTypes: {
          violations: [
            { sample: 'innerHTML=<script>bad</script>', blockedURI: 'trusted-types-sink', effectiveDirective: 'require-trusted-types-for' },
            { sample: 'eval call', blockedURI: 'script', effectiveDirective: 'script-src' },
          ],
        },
      });
      const detections = classifyBrowserPlatform(envelope, BASE_OPTS);
      expect(detections).toHaveLength(2);
      expect(detections.every(d => d.kind === 'trusted_types_violation')).toBe(true);
    });

    it('captures sample and blockedURI in context', () => {
      const envelope = makeEnvelope({
        trustedTypes: {
          violations: [
            { sample: 'some-sink', blockedURI: 'https://example.com/sink', effectiveDirective: 'require-trusted-types-for' },
          ],
        },
      });
      const detections = classifyBrowserPlatform(envelope, BASE_OPTS);
      const ctx = detections[0].browserPlatformContext;
      expect(ctx?.kind).toBe('trusted_types');
      if (ctx?.kind === 'trusted_types') {
        expect(ctx.sample).toBe('some-sink');
        expect(ctx.blockedURI).toBe('https://example.com/sink');
        expect(ctx.source).toBe('dynamic');
      }
    });
  });

  it('classifies multiple kinds simultaneously', () => {
    const envelope = makeEnvelope({
      workers: { errors: [{ scriptUrl: '/w.js', kind: 'error', errorMsg: 'fail' }] },
      trustedTypes: { violations: [{ sample: 's', blockedURI: 'b', effectiveDirective: 'r' }] },
      isolation: { crossOriginIsolated: false, sabReferenced: true, sabInstantiated: false },
    });
    const detections = classifyBrowserPlatform(envelope, BASE_OPTS);
    expect(detections).toHaveLength(3);
    const kinds = detections.map(d => d.kind);
    expect(kinds).toContain('web_worker_error');
    expect(kinds).toContain('trusted_types_violation');
    expect(kinds).toContain('coop_coep_violation');
  });
});
