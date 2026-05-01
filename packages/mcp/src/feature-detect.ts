// Feature-detect helpers for V26 (DETECTOR_REGISTRY), V27 (history/diff), V28 (explanations).
// Each probe does a dynamic import and caches the result. On ERR_MODULE_NOT_FOUND → false.
// Any other error propagates (it indicates a different kind of failure, not "not landed yet").

type ProbeResult = { available: boolean; module?: unknown };

const cache = new Map<string, ProbeResult>();

async function probe(specifier: string): Promise<ProbeResult> {
  const cached = cache.get(specifier);
  if (cached !== undefined) return cached;

  try {
    const mod: unknown = await import(specifier);
    const result: ProbeResult = { available: true, module: mod };
    cache.set(specifier, result);
    return result;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND') {
      const result: ProbeResult = { available: false };
      cache.set(specifier, result);
      return result;
    }
    throw e;
  }
}

export async function v26Available(): Promise<{ available: boolean; registry?: unknown }> {
  const result = await probe('bughunter/src/detectors/registry.js');
  return { available: result.available, registry: result.module };
}

export async function v27DiffAvailable(): Promise<{ available: boolean; diff?: unknown }> {
  const result = await probe('bughunter/src/history/diff.js');
  return { available: result.available, diff: result.module };
}

export async function v27HistoryAvailable(): Promise<{ available: boolean; history?: unknown }> {
  const result = await probe('bughunter/src/history/history.js');
  return { available: result.available, history: result.module };
}

export async function v28Available(): Promise<{ available: boolean; explain?: unknown }> {
  const result = await probe('bughunter/src/explain/cache.js');
  return { available: result.available, explain: result.module };
}

/** Clear the module cache (for testing only). */
export function clearFeatureDetectCache(): void {
  cache.clear();
}
