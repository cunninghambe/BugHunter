// Tests for V53.1 multi-surface orchestration: mergePerSurfaceConfig and runMultiSurfacePipeline.

import { describe, it, expect, vi } from 'vitest';
import { mergePerSurfaceConfig, runMultiSurfacePipeline } from './run.js';
import type { BugHunterConfig } from '../types.js';
import type { SurfaceListSurfacesResult } from '../adapters/surface-mcp.js';
import { HttpSurfaceMcpAdapter, BoundSurfaceMcpAdapter } from '../adapters/surface-mcp.js';

// ──────────────────────────────────────────────────
// mergePerSurfaceConfig
// ──────────────────────────────────────────────────

const BASE_CONFIG: BugHunterConfig = {
  projectName: 'test',
  surfaceMcpUrl: 'http://localhost:3140',
  auth: { kind: 'none' },
  roles: ['anonymous'],
  concurrency: 4,
  apiConcurrency: 2,
  budgetMs: 30_000,
  excludedRoutes: ['/health'],
};

describe('mergePerSurfaceConfig', () => {
  it('returns base config unchanged when surface has no override', () => {
    const result = mergePerSurfaceConfig(BASE_CONFIG, 'self-api');
    expect(result.auth).toEqual({ kind: 'none' });
    expect(result.roles).toEqual(['anonymous']);
    expect(result.concurrency).toBe(4);
  });

  it('per-surface auth wins over top-level auth', () => {
    const config: BugHunterConfig = {
      ...BASE_CONFIG,
      auth: undefined,
      surfaces: {
        'self-api': { auth: { kind: 'none' } },
      },
    };
    const result = mergePerSurfaceConfig(config, 'self-api');
    expect(result.auth).toEqual({ kind: 'none' });
  });

  it('top-level auth falls through when surface has no auth override', () => {
    const config: BugHunterConfig = {
      ...BASE_CONFIG,
      auth: { kind: 'none' },
      surfaces: { 'self-api': {} },
    };
    const result = mergePerSurfaceConfig(config, 'self-api');
    expect(result.auth).toEqual({ kind: 'none' });
  });

  it('per-surface roles win over top-level roles', () => {
    const config: BugHunterConfig = {
      ...BASE_CONFIG,
      roles: ['anonymous'],
      surfaces: { 'idor-bad': { roles: ['alice', 'bob'] } },
    };
    const result = mergePerSurfaceConfig(config, 'idor-bad');
    expect(result.roles).toEqual(['alice', 'bob']);
  });

  it('excludedRoutes is additive — surface list appends to top-level', () => {
    const config: BugHunterConfig = {
      ...BASE_CONFIG,
      excludedRoutes: ['/health'],
      surfaces: { 'self-api': { excludedRoutes: ['/metrics'] } },
    };
    const result = mergePerSurfaceConfig(config, 'self-api');
    expect(result.excludedRoutes).toContain('/health');
    expect(result.excludedRoutes).toContain('/metrics');
    expect(result.excludedRoutes).toHaveLength(2);
  });

  it('per-surface concurrency override', () => {
    const config: BugHunterConfig = {
      ...BASE_CONFIG,
      concurrency: 4,
      surfaces: { 'pen-bad': { concurrency: 1 } },
    };
    const result = mergePerSurfaceConfig(config, 'pen-bad');
    expect(result.concurrency).toBe(1);
  });
});

// ──────────────────────────────────────────────────
// runMultiSurfacePipeline
// ──────────────────────────────────────────────────

function makeHttpAdapter(): HttpSurfaceMcpAdapter {
  return new HttpSurfaceMcpAdapter('http://localhost:3140');
}

describe('runMultiSurfacePipeline', () => {
  it('iterates over ready surfaces and calls runPhaseForSurface once per surface', async () => {
    const topology: SurfaceListSurfacesResult = {
      surfaceMcpVersion: '0.3.0',
      surfaces: [
        { name: 'self-api', stack: 'openapi', baseUrl: 'http://localhost:5791', state: { kind: 'ready' }, toolCount: 5, pageCount: 0, navigationCount: 0, toolRevision: 1, capabilities: { listPages: false, listNavigations: false, enumerateRoutesRuntime: false, crawlSeed: false } },
        { name: 'self-spa', stack: 'vite', baseUrl: 'http://localhost:5790', state: { kind: 'ready' }, toolCount: 0, pageCount: 3, navigationCount: 2, toolRevision: 1, capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: true, crawlSeed: false } },
      ],
    };

    const called: string[] = [];
    const adapter = makeHttpAdapter();

    const results = await runMultiSurfacePipeline(
      adapter,
      topology,
      BASE_CONFIG,
      async (bound, _config, surfaceName) => {
        called.push(surfaceName);
        expect(bound).toBeInstanceOf(BoundSurfaceMcpAdapter);
        expect(bound.getSurfaceName()).toBe(surfaceName);
      },
    );

    expect(called).toEqual(['self-api', 'self-spa']);
    expect(results).toHaveLength(2);
    expect(results[0].skipped).toBe(false);
    expect(results[1].skipped).toBe(false);
  });

  it('skips surfaces with state.kind !== ready', async () => {
    const topology: SurfaceListSurfacesResult = {
      surfaceMcpVersion: '0.3.0',
      surfaces: [
        { name: 'self-api', stack: 'openapi', baseUrl: 'http://localhost:5791', state: { kind: 'ready' }, toolCount: 5, pageCount: 0, navigationCount: 0, toolRevision: 1, capabilities: { listPages: false, listNavigations: false, enumerateRoutesRuntime: false, crawlSeed: false } },
        { name: 'pen-bad', stack: 'openapi', baseUrl: 'http://localhost:4091', state: { kind: 'failed', phase: 'extract', error: 'server not found' }, toolCount: 0, pageCount: 0, navigationCount: 0, toolRevision: 0, capabilities: { listPages: false, listNavigations: false, enumerateRoutesRuntime: false, crawlSeed: false } },
      ],
    };

    const called: string[] = [];
    const adapter = makeHttpAdapter();

    const results = await runMultiSurfacePipeline(
      adapter,
      topology,
      BASE_CONFIG,
      async (_bound, _config, surfaceName) => { called.push(surfaceName); },
    );

    expect(called).toEqual(['self-api']);
    expect(results).toHaveLength(2);
    expect(results[0].skipped).toBe(false);
    expect(results[1].skipped).toBe(true);
    expect(results[1].surfaceName).toBe('pen-bad');
  });

  it('passes merged per-surface config to the phase runner', async () => {
    const config: BugHunterConfig = {
      ...BASE_CONFIG,
      surfaces: { 'idor-bad': { roles: ['alice', 'bob'] } },
    };
    const topology: SurfaceListSurfacesResult = {
      surfaceMcpVersion: '0.3.0',
      surfaces: [
        { name: 'idor-bad', stack: 'openapi', baseUrl: 'http://localhost:4090', state: { kind: 'ready' }, toolCount: 2, pageCount: 0, navigationCount: 0, toolRevision: 1, capabilities: { listPages: false, listNavigations: false, enumerateRoutesRuntime: false, crawlSeed: false } },
      ],
    };

    const seenRoles: string[][] = [];
    const adapter = makeHttpAdapter();

    await runMultiSurfacePipeline(
      adapter,
      topology,
      config,
      async (_bound, surfaceConfig) => { seenRoles.push(surfaceConfig.roles ?? []); },
    );

    expect(seenRoles[0]).toEqual(['alice', 'bob']);
  });

  it('single-surface topology still creates a BoundSurfaceMcpAdapter', async () => {
    const topology: SurfaceListSurfacesResult = {
      surfaceMcpVersion: '0.3.0',
      surfaces: [
        { name: 'self-spa', stack: 'vite', baseUrl: 'http://localhost:5790', state: { kind: 'ready' }, toolCount: 0, pageCount: 3, navigationCount: 0, toolRevision: 1, capabilities: { listPages: true, listNavigations: false, enumerateRoutesRuntime: false, crawlSeed: false } },
      ],
    };

    const adapter = makeHttpAdapter();
    const seenAdapters: BoundSurfaceMcpAdapter[] = [];

    await runMultiSurfacePipeline(
      adapter,
      topology,
      BASE_CONFIG,
      async (bound) => { seenAdapters.push(bound); },
    );

    expect(seenAdapters).toHaveLength(1);
    expect(seenAdapters[0]).toBeInstanceOf(BoundSurfaceMcpAdapter);
    expect(seenAdapters[0].getSurfaceName()).toBe('self-spa');
  });
});

// ──────────────────────────────────────────────────
// V53.1: detection.surface stamping (Bug 2)
// ──────────────────────────────────────────────────

describe('runMultiSurfacePipeline — V53.1 detection.surface stamping', () => {
  it('callback receives surfaceName so caller can stamp detection.surface', async () => {
    const topology: SurfaceListSurfacesResult = {
      surfaceMcpVersion: '0.3.0',
      surfaces: [
        { name: 'self-spa', stack: 'vite', baseUrl: 'http://localhost:5790', state: { kind: 'ready' }, toolCount: 0, pageCount: 3, navigationCount: 2, toolRevision: 1, capabilities: { listPages: true, listNavigations: true, enumerateRoutesRuntime: true, crawlSeed: false } },
        { name: 'self-api', stack: 'openapi', baseUrl: 'http://localhost:5791', state: { kind: 'ready' }, toolCount: 5, pageCount: 0, navigationCount: 0, toolRevision: 1, capabilities: { listPages: false, listNavigations: false, enumerateRoutesRuntime: false, crawlSeed: false } },
      ],
    };

    type FakeBug = { kind: string; rootCause: string; surface?: string };
    const collectedBugs: FakeBug[] = [];
    const adapter = makeHttpAdapter();

    await runMultiSurfacePipeline(
      adapter,
      topology,
      BASE_CONFIG,
      async (_bound, _config, surfaceName) => {
        // Simulate what runExecute returns (detections without surface set)
        const detections: FakeBug[] = [
          { kind: 'console_error', rootCause: `error on ${surfaceName}` },
        ];
        // Stamp surface — mirrors what runCommand does post-execute
        detections.forEach(d => { if (d.surface === undefined) d.surface = surfaceName; });
        collectedBugs.push(...detections);
      },
    );

    expect(collectedBugs).toHaveLength(2);
    expect(collectedBugs[0].surface).toBe('self-spa');
    expect(collectedBugs[1].surface).toBe('self-api');
  });

  it('clusters from multi-surface run carry distinct surface origins', async () => {
    const surfaces = ['self-spa', 'self-api', 'race-bad'];
    const topology: SurfaceListSurfacesResult = {
      surfaceMcpVersion: '0.3.0',
      surfaces: surfaces.map(name => ({
        name,
        stack: name === 'self-spa' ? 'vite' as const : 'openapi' as const,
        baseUrl: `http://localhost:${5000 + surfaces.indexOf(name)}`,
        state: { kind: 'ready' as const },
        toolCount: 1, pageCount: 0, navigationCount: 0, toolRevision: 1,
        capabilities: { listPages: false, listNavigations: false, enumerateRoutesRuntime: false, crawlSeed: false },
      })),
    };

    const stampedSurfaces: string[] = [];
    const adapter = makeHttpAdapter();

    await runMultiSurfacePipeline(
      adapter,
      topology,
      BASE_CONFIG,
      async (_bound, _config, surfaceName) => {
        stampedSurfaces.push(surfaceName);
      },
    );

    // Each surface was visited and its name is available for stamping
    expect(new Set(stampedSurfaces).size).toBe(3);
    expect(stampedSurfaces).toContain('self-spa');
    expect(stampedSurfaces).toContain('self-api');
    expect(stampedSurfaces).toContain('race-bad');
  });

  it('BoundSurfaceMcpAdapter.getSurfaceName() returns the surface name used for stamping', async () => {
    const topology: SurfaceListSurfacesResult = {
      surfaceMcpVersion: '0.3.0',
      surfaces: [
        { name: 'self-spa', stack: 'vite', baseUrl: 'http://localhost:5790', state: { kind: 'ready' }, toolCount: 0, pageCount: 1, navigationCount: 0, toolRevision: 1, capabilities: { listPages: true, listNavigations: false, enumerateRoutesRuntime: false, crawlSeed: false } },
      ],
    };

    const adapter = makeHttpAdapter();
    let capturedSurfaceName: string | undefined;

    await runMultiSurfacePipeline(
      adapter,
      topology,
      BASE_CONFIG,
      async (bound, _config, surfaceName) => {
        // getSurfaceName() must equal the surfaceName passed as 3rd arg
        capturedSurfaceName = bound.getSurfaceName();
        expect(capturedSurfaceName).toBe(surfaceName);
      },
    );

    expect(capturedSurfaceName).toBe('self-spa');
  });
});

// ──────────────────────────────────────────────────
// audit fix #8: per-surface appBaseUrl from topology
// ──────────────────────────────────────────────────

describe('runMultiSurfacePipeline — audit fix #8: per-surface appBaseUrl', () => {
  it('injects summary.baseUrl as appBaseUrl so race-runner dispatches to race-bad port (9994), not global appBaseUrl (5790)', async () => {
    const topology: SurfaceListSurfacesResult = {
      surfaceMcpVersion: '0.3.0',
      surfaces: [
        { name: 'self-spa', stack: 'vite', baseUrl: 'http://localhost:5790', state: { kind: 'ready' }, toolCount: 0, pageCount: 3, navigationCount: 0, toolRevision: 1, capabilities: { listPages: true, listNavigations: false, enumerateRoutesRuntime: false, crawlSeed: false } },
        { name: 'race-bad', stack: 'openapi', baseUrl: 'http://localhost:9994', state: { kind: 'ready' }, toolCount: 5, pageCount: 0, navigationCount: 0, toolRevision: 1, capabilities: { listPages: false, listNavigations: false, enumerateRoutesRuntime: false, crawlSeed: false } },
      ],
    };

    // Global config has the SPA's URL as appBaseUrl — the bug before fix #8
    const config: BugHunterConfig = { ...BASE_CONFIG, appBaseUrl: 'http://localhost:5790' };
    const seenBaseUrls: Record<string, string | undefined> = {};
    const adapter = makeHttpAdapter();

    await runMultiSurfacePipeline(
      adapter,
      topology,
      config,
      async (_bound, surfaceConfig, surfaceName) => {
        seenBaseUrls[surfaceName] = surfaceConfig.appBaseUrl;
      },
    );

    // race-bad must see its own port (9994), not the global 5790
    expect(seenBaseUrls['race-bad']).toBe('http://localhost:9994');
    // self-spa still gets its declared baseUrl
    expect(seenBaseUrls['self-spa']).toBe('http://localhost:5790');
  });
});

// ──────────────────────────────────────────────────
// Integration: 6-surface topology produces ≥3 distinct surface names
// ──────────────────────────────────────────────────

describe('runMultiSurfacePipeline — 6-surface integration (mocked)', () => {
  it('aggregates results from ≥3 distinct surface origins', async () => {
    const sixSurfaces = [
      'self-api', 'self-spa', 'race-bad', 'idor-bad', 'v24-deferred-bugs', 'pen-bad',
    ];
    const topology: SurfaceListSurfacesResult = {
      surfaceMcpVersion: '0.3.0',
      surfaces: sixSurfaces.map(name => ({
        name,
        stack: name.includes('spa') || name.includes('deferred') ? 'vite' as const : 'openapi' as const,
        baseUrl: `http://localhost:${5000 + sixSurfaces.indexOf(name)}`,
        state: { kind: 'ready' as const },
        toolCount: 1,
        pageCount: 0,
        navigationCount: 0,
        toolRevision: 1,
        capabilities: { listPages: false, listNavigations: false, enumerateRoutesRuntime: false, crawlSeed: false },
      })),
    };

    const visitedSurfaces: string[] = [];
    const adapter = makeHttpAdapter();

    const results = await runMultiSurfacePipeline(
      adapter,
      topology,
      BASE_CONFIG,
      async (_bound, _config, surfaceName) => { visitedSurfaces.push(surfaceName); },
    );

    expect(new Set(visitedSurfaces).size).toBeGreaterThanOrEqual(3);
    expect(results.filter(r => !r.skipped)).toHaveLength(6);
  });
});
