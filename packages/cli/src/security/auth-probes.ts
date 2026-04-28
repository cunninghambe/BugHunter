// Auth-probe: no-rate-limit-on-login detection (v0.5 §3.3).

import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BugDetection } from '../types.js';
import type { RateLimitProfile } from './rate-limit-discovery.js';
import { discoverRateLimit } from './rate-limit-discovery.js';
import { log } from '../log.js';

export type AuthProbeOptions = {
  surface: SurfaceMcpAdapter;
  loginToolId: string;
  maxAttempts: number;
  testUsername?: string;
  sacrificialEndpoint?: string;
  /** Override the inter-attempt delay. Intended for testing only. */
  delayOverrideMs?: number;
};

export type AuthProbeResult = {
  detections: BugDetection[];
  rateLimitProfile: RateLimitProfile;
};

const FALLBACK_USERNAME = 'bughunter-probe-user@invalid.test';
const FALLBACK_PASSWORD = 'BugHunterProbe!Invalid999';

export async function runAuthProbes(opts: AuthProbeOptions): Promise<AuthProbeResult> {
  const { surface, loginToolId, maxAttempts, testUsername, sacrificialEndpoint, delayOverrideMs } = opts;

  const profile = await discoverRateLimit(
    surface,
    sacrificialEndpoint ?? loginToolId,
  );

  const cap = Math.min(maxAttempts, 50);
  const username = testUsername ?? FALLBACK_USERNAME;

  log.info('auth-probe: starting no-rate-limit probe', { loginToolId, cap, username });

  let rateLimitHit = false;
  let attempt = 0;

  while (attempt < cap) {
    try {
      const result = await surface.surface_call({
        toolId: loginToolId,
        role: 'anonymous',
        input: { email: username, password: FALLBACK_PASSWORD },
        noAutoRelogin: true,
      });

      const status = result.status ?? 0;

      if (status === 429 || status === 423) {
        rateLimitHit = true;
        log.info('auth-probe: rate limit observed', { status, attempt });
        break;
      }
    } catch (err) {
      log.warn('auth-probe: request error', { attempt, err: String(err) });
    }

    attempt++;

    // Throttle between attempts to respect rate-limit profile
    if (attempt < cap) {
      await sleep(delayOverrideMs ?? profile.delayBetweenAttemptsMs);
    }
  }

  if (!rateLimitHit && attempt >= cap) {
    log.info('auth-probe: no rate limit observed after max attempts', { cap, loginToolId });
    return {
      detections: [{
        kind: 'no_rate_limit_on_login',
        rootCause: `Login endpoint accepted ${cap} bogus-credential POSTs without 429/423`,
        endpoint: loginToolId,
      }],
      rateLimitProfile: profile,
    };
  }

  return { detections: [], rateLimitProfile: profile };
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms); });
}
