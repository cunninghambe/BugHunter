// Rate-limit discovery pre-flight probe (v0.5 §3.3).

import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { log } from '../log.js';

export type RateLimitProfile = {
  source: 'observed' | 'fallback';
  limit?: number;
  intervalMs?: number;
  concurrency: number;
  delayBetweenAttemptsMs: number;
};

const RATE_LIMIT_HEADERS = [
  'ratelimit-limit',
  'x-ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
  'x-ratelimit-reset',
  'retry-after',
];

export async function discoverRateLimit(
  surface: SurfaceMcpAdapter,
  sacrificialEndpoint: string,
): Promise<RateLimitProfile> {
  const observedHeaders: Partial<Record<string, string>> = {};

  // Send 5 sequential GETs; observe headers
  for (let i = 0; i < 5; i++) {
    try {
      const result = await surface.surface_call({
        toolId: sacrificialEndpoint,
        role: 'anonymous',
        input: {},
        noAutoRelogin: true,
      });
      if (result.headers !== undefined) {
        for (const [k, v] of Object.entries(result.headers)) {
          observedHeaders[k.toLowerCase()] = v;
        }
      }
    } catch (err) {
      log.warn('rate-limit-discovery: probe request failed', { err: String(err) });
    }
  }

  const hasRateLimitHeaders = RATE_LIMIT_HEADERS.some(h => h in observedHeaders);
  if (!hasRateLimitHeaders) {
    return { source: 'fallback', concurrency: 1, delayBetweenAttemptsMs: 200 };
  }

  const limitRaw: string | undefined = observedHeaders['ratelimit-limit'] ?? observedHeaders['x-ratelimit-limit'];
  const resetRaw: string | undefined = observedHeaders['ratelimit-reset'] ?? observedHeaders['x-ratelimit-reset'];

  if (limitRaw === undefined || resetRaw === undefined) {
    return { source: 'fallback', concurrency: 1, delayBetweenAttemptsMs: 200 };
  }

  const limit = parseInt(limitRaw, 10);
  const resetSec = parseInt(resetRaw, 10);
  const intervalMs = !Number.isNaN(resetSec) ? resetSec * 1000 : undefined;

  if (Number.isNaN(limit) || intervalMs === undefined) {
    return { source: 'fallback', concurrency: 1, delayBetweenAttemptsMs: 200 };
  }

  const concurrency = Math.max(1, Math.floor(limit / 4));
  const delayBetweenAttemptsMs = Math.ceil((intervalMs / limit) * 4);

  return { source: 'observed', limit, intervalMs, concurrency, delayBetweenAttemptsMs };
}
