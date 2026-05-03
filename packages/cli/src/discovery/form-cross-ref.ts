// Cross-references forms to API tools via surface_routes_for_page (§ 3.3).
// Falls back to direct action+method matching against apiTools when
// surface_routes_for_page returns 0 tools (e.g. Vite SPA surfaces). See SurfaceMCP#23.

import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { DiscoveredForm, ToolMeta } from '../types.js';
import { log } from '../log.js';

/**
 * Normalizes a form action to a plain pathname for comparison against ToolMeta.path.
 * Handles absolute URLs (strips origin), relative paths (returns as-is),
 * and undefined (returns empty string so the form is unmatched).
 */
export function normalizeActionPath(action: string | undefined): string {
  if (action === undefined || action === '') return '';
  try {
    return new URL(action).pathname;
  } catch {
    // relative path — already a pathname
    return action.startsWith('/') ? action : `/${action}`;
  }
}

/** Resolves each form's apiToolIds by matching action+method against the apiTools list. */
function resolveByActionMatch(forms: DiscoveredForm[], apiTools: ToolMeta[]): DiscoveredForm[] {
  return forms.map(form => {
    const actionPath = normalizeActionPath(form.action);
    if (actionPath === '') return { ...form, apiToolIds: [] };

    const method = form.method.toUpperCase();
    const matched = apiTools.filter(
      t => t.path === actionPath && t.method.toUpperCase() === method
    );

    if (matched.length === 0) {
      log.warn(`form action ${method} ${actionPath} — no matching api tool`);
      return { ...form, apiToolIds: [] };
    }

    log.info(`form action ${method} ${actionPath} → [${matched.map(t => t.toolId).join(', ')}] (cross-surface match)`);
    return { ...form, apiToolIds: matched.map(t => t.toolId) };
  });
}

export async function crossRefForms(
  forms: DiscoveredForm[],
  pagePath: string,
  surface: SurfaceMcpAdapter,
  apiTools?: ToolMeta[]
): Promise<DiscoveredForm[]> {
  const result = await surface.surface_routes_for_page({ pagePath }).catch((err: unknown) => {
    log.warn(`surface_routes_for_page failed for ${pagePath}`, err);
    return null;
  });

  const toolIds = result?.tools.map(t => t.toolId) ?? [];

  if (toolIds.length > 0) {
    return forms.map(f => ({ ...f, apiToolIds: toolIds }));
  }

  // surface_routes_for_page returned 0 tools (typical for Vite SPA surfaces that
  // have no API routes). Fall back to direct action+method matching against the
  // api-surface tool catalog when one was supplied. SurfaceMCP#23.
  if (apiTools !== undefined && apiTools.length > 0) {
    log.info(`surface_routes_for_page returned 0 tools for ${pagePath} — trying cross-surface action match`);
    return resolveByActionMatch(forms, apiTools);
  }

  log.warn(`No API tools found for page ${pagePath} — forms will be skipped`);
  return forms.map(f => ({ ...f, apiToolIds: [] }));
}
