// Unit tests for discoverPages dispatcher (spec § 6.2)

import { describe, it, expect, vi } from 'vitest';
import { discoverPages } from '../../src/discovery/pages.js';
import type { SurfaceMcpAdapter } from '../../src/adapters/surface-mcp.js';
import type { SurfaceDescribeSelfResult, SurfaceListPagesResult } from '../../src/adapters/surface-mcp.js';
import * as path from 'node:path';

function makeAdapter(overrides: Partial<SurfaceMcpAdapter>): SurfaceMcpAdapter {
  return {
    surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools: [] }),
    surface_describe_tool: vi.fn(),
    surface_call: vi.fn(),
    surface_probe: vi.fn(),
    surface_sample_inputs: vi.fn(),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
    surface_list_pages: vi.fn().mockResolvedValue({ revision: 1, pages: [] }),
    surface_describe_self: vi.fn().mockRejectedValue(new Error('not_found')),
    ...overrides,
  } as SurfaceMcpAdapter;
}

function describeResult(partial: Partial<SurfaceDescribeSelfResult>): SurfaceDescribeSelfResult {
  return {
    name: 'test',
    stack: 'nextjs',
    baseUrl: 'http://localhost:3000',
    toolRevision: 1,
    pageRevision: 1,
    capabilities: { listPages: false },
    ...partial,
  };
}

describe('discoverPages — nextjs calls discoverFilesystemPages', () => {
  it('stack: nextjs returns filesystem-discovered pages', async () => {
    const adapter = makeAdapter({
      surface_describe_self: vi.fn().mockResolvedValue(
        describeResult({ stack: 'nextjs', capabilities: { listPages: false } })
      ),
    });

    // Use the SurfaceMCP nextjs-app fixture which has real app/ pages
    const projectDir = '/root/SurfaceMCP/fixtures/nextjs-app';
    const pages = await discoverPages(projectDir, adapter);

    expect(pages.length).toBeGreaterThan(0);
    // All sourceFiles should be absolute paths
    for (const p of pages) {
      if (p.sourceFile) {
        expect(path.isAbsolute(p.sourceFile), `expected absolute path, got ${p.sourceFile}`).toBe(true);
      }
    }
    // surface_list_pages should NOT have been called
    expect(adapter.surface_list_pages).not.toHaveBeenCalled();
  });
});

describe('discoverPages — vite calls surface_list_pages', () => {
  it('stack: vite maps pages correctly', async () => {
    const mockPage = {
      route: '/about',
      sourceFile: 'src/pages/About.tsx',
      componentName: 'About',
      lazy: true,
      dynamicParams: [],
      declaredAt: { file: 'src/App.tsx', line: 10 },
    };

    const listPagesResult: SurfaceListPagesResult = {
      revision: 1,
      pages: [mockPage],
    };

    const adapter = makeAdapter({
      surface_describe_self: vi.fn().mockResolvedValue(
        describeResult({ stack: 'vite', capabilities: { listPages: true } })
      ),
      surface_list_pages: vi.fn().mockResolvedValue(listPagesResult),
    });

    const projectDir = '/tmp/fake-vite-project';
    const pages = await discoverPages(projectDir, adapter);

    expect(pages.length).toBe(1);
    expect(pages[0]!.route).toBe('/about');
    expect(pages[0]!.sourceFile).toBe(path.join(projectDir, 'src/pages/About.tsx'));
    expect(adapter.surface_list_pages).toHaveBeenCalledOnce();
  });

  it('stack: vite with "<unresolved>" sourceFile maps to undefined', async () => {
    const mockPage = {
      route: '/ghost',
      sourceFile: '<unresolved>',
      componentName: 'Ghost',
      lazy: false,
      dynamicParams: [],
      declaredAt: { file: 'src/App.tsx', line: 5 },
    };

    const adapter = makeAdapter({
      surface_describe_self: vi.fn().mockResolvedValue(
        describeResult({ stack: 'vite', capabilities: { listPages: true } })
      ),
      surface_list_pages: vi.fn().mockResolvedValue({ revision: 1, pages: [mockPage] }),
    });

    const pages = await discoverPages('/tmp/project', adapter);
    expect(pages[0]!.sourceFile).toBeUndefined();
  });
});

describe('discoverPages — backend stacks return empty', () => {
  it.each(['express', 'fastapi', 'django', 'openapi'] as const)(
    'stack: %s returns []',
    async (stack) => {
      const adapter = makeAdapter({
        surface_describe_self: vi.fn().mockResolvedValue(
          describeResult({ stack, capabilities: { listPages: false } })
        ),
      });

      const pages = await discoverPages('/tmp/backend', adapter);
      expect(pages).toEqual([]);
      expect(adapter.surface_list_pages).not.toHaveBeenCalled();
    }
  );
});

describe('discoverPages — fallback when surface_describe_self unavailable', () => {
  it('falls back to discoverFilesystemPages on error', async () => {
    const adapter = makeAdapter({
      surface_describe_self: vi.fn().mockRejectedValue(new Error('not_found')),
    });

    // nextjs-app fixture has real pages
    const projectDir = '/root/SurfaceMCP/fixtures/nextjs-app';
    const pages = await discoverPages(projectDir, adapter);
    // Should have found pages from filesystem
    expect(pages.length).toBeGreaterThan(0);
  });
});

// Case 15: stack vite with seed page — source propagated through discoverPages
describe('discoverPages — source: crawl_seed propagated (case 15)', () => {
  it('returns one entry with source: crawl_seed', async () => {
    const seedPage: SurfaceListPagesResult = {
      revision: 1,
      pages: [{
        route: '/',
        sourceFile: '<unresolved>',
        lazy: false,
        dynamicParams: [],
        declaredAt: { file: '<crawl-seed>', line: 0 },
        source: 'crawl_seed',
      }],
    };
    const adapter = makeAdapter({
      surface_describe_self: vi.fn().mockResolvedValue(
        describeResult({ stack: 'vite', capabilities: { listPages: true, crawlSeed: true } })
      ),
      surface_list_pages: vi.fn().mockResolvedValue(seedPage),
    });

    const pages = await discoverPages('/tmp/project', adapter);
    expect(pages.length).toBe(1);
    expect(pages[0]!.source).toBe('crawl_seed');
    expect(pages[0]!.route).toBe('/');
    expect(pages[0]!.sourceFile).toBeUndefined(); // '<unresolved>' maps to undefined
  });
});

// Case 16: source field is preserved on the returned DiscoveredPageMeta
describe('discoverPages — source field preserved (case 16)', () => {
  it('source: static is preserved when present', async () => {
    const staticPage: SurfaceListPagesResult = {
      revision: 1,
      pages: [{
        route: '/about',
        sourceFile: 'src/About.tsx',
        lazy: false,
        dynamicParams: [],
        declaredAt: { file: 'src/App.tsx', line: 5 },
        source: 'static',
      }],
    };
    const adapter = makeAdapter({
      surface_describe_self: vi.fn().mockResolvedValue(
        describeResult({ stack: 'vite', capabilities: { listPages: true } })
      ),
      surface_list_pages: vi.fn().mockResolvedValue(staticPage),
    });

    const pages = await discoverPages('/tmp/project', adapter);
    expect(pages[0]!.source).toBe('static');
  });
});
