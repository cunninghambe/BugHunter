// Stack-aware page discovery (spec § 3.1).
// Dispatches on `surface_describe_self().stack`:
//   - 'nextjs': filesystem walk via discoverFilesystemPages
//   - 'vite' (or any stack with capabilities.listPages):  surface_list_pages
//   - backend-only stacks: []
//
// Falls back to discoverFilesystemPages when surface_describe_self is unavailable
// (SurfaceMCP < 0.2) for backward-compat.

import * as path from 'node:path';
import type { SurfaceMcpAdapter, PageSource } from '../adapters/surface-mcp.js';
import { discoverFilesystemPages } from './filesystem-pages.js';
import { log } from '../log.js';

export type DiscoveredPageMeta = {
  route: string;
  sourceFile?: string;  // absolute path; undefined when SurfaceMCP returned '<unresolved>'
  /** Propagated from SurfaceMCP. Absent/undefined ≡ 'static'. */
  source?: PageSource;
};

export async function discoverPages(
  projectDir: string,
  surface: SurfaceMcpAdapter
): Promise<DiscoveredPageMeta[]> {
  let selfResult: Awaited<ReturnType<SurfaceMcpAdapter['surface_describe_self']>> | undefined;

  try {
    selfResult = await surface.surface_describe_self();
  } catch {
    log.warn('WARN bughunter: SurfaceMCP < 0.2 detected; falling back to filesystem-only page discovery');
    const fsPages = await discoverFilesystemPages(projectDir);
    return fsPages.map(p => ({ route: p.route, sourceFile: p.sourceFile }));
  }

  const { stack, capabilities } = selfResult;

  if (stack === 'nextjs') {
    const fsPages = await discoverFilesystemPages(projectDir);
    return fsPages.map(p => ({ route: p.route, sourceFile: p.sourceFile }));
  }

  if (capabilities.listPages) {
    const result = await surface.surface_list_pages();
    if (result.pages.length === 0) {
      const skips = result.skips ?? [];
      const skipReasons = skips.map(s => s.reason).join(', ');
      log.warn(
        `WARN bughunter: surface_list_pages returned 0 pages for stack=${stack}${ 
        skipReasons ? ` with skips: ${skipReasons}` : ''}`
      );
    }
    return result.pages.map(p => ({
      route: p.route,
      sourceFile: p.sourceFile === '<unresolved>' ? undefined : path.join(projectDir, p.sourceFile),
      source: p.source,
    }));
  }

  // Backend-only stacks and unknown stacks without listPages capability return empty.
  // For backend-only, this is explicit (no UI surface to discover).
  log.info(`backend-only stack (${stack}) — UI tests skipped`);
  return [];
}
