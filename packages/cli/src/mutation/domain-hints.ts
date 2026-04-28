// Resolves domain hints for slug and foreign_id types.
// Priority: surface_sample_inputs > domainHints config > skip with warning.

import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { log } from '../log.js';

export async function resolveDomainHint(
  type: 'slug' | 'foreign_id',
  toolId: string | undefined,
  surface: SurfaceMcpAdapter,
  domainHints: Record<string, string[]> | undefined
): Promise<unknown | undefined> {
  if (toolId) {
    const samples = await surface.surface_sample_inputs({ toolId }).catch(() => null);
    if (samples?.samples.length) {
      for (const s of samples.samples) {
        const obj = s.input as Record<string, unknown> | null;
        if (obj && typeof obj === 'object') {
          for (const val of Object.values(obj)) {
            if (type === 'slug' && typeof val === 'string' && /^[a-z0-9-]+$/.test(val)) return val;
            if (type === 'foreign_id' && (typeof val === 'number' || typeof val === 'string')) return val;
          }
        }
      }
    }
  }
  const hint = domainHints?.[type]?.[0];
  if (!hint) {
    log.warn(`No domain hint for ${type} — skipping happy-path value`);
  }
  return hint;
}
