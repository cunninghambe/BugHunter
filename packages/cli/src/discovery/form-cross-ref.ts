// Cross-references forms to API tools via surface_routes_for_page (§ 3.3).

import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { DiscoveredForm } from '../types.js';
import { log } from '../log.js';

export async function crossRefForms(
  forms: DiscoveredForm[],
  pagePath: string,
  surface: SurfaceMcpAdapter
): Promise<DiscoveredForm[]> {
  const result = await surface.surface_routes_for_page({ pagePath }).catch((err: unknown) => {
    log.warn(`surface_routes_for_page failed for ${pagePath}`, err);
    return null;
  });

  const toolIds = result?.tools.map(t => t.toolId) ?? [];

  if (toolIds.length === 0) {
    log.warn(`No API tools found for page ${pagePath} — forms will be skipped`);
    return forms.map(f => ({ ...f, apiToolIds: [] }));
  }

  // Assign found tool IDs to all forms on the page (best-effort)
  return forms.map(f => ({ ...f, apiToolIds: toolIds }));
}
