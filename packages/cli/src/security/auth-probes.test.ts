// Tests for auth-probe (v0.5 §3.3).

import { describe, it, expect, vi } from 'vitest';
import { runAuthProbes } from './auth-probes.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';

function makeSurface(statusSequence: number[]): SurfaceMcpAdapter {
  let callCount = -1;
  return {
    surface_call: vi.fn().mockImplementation(async () => {
      callCount++;
      const status = statusSequence[Math.min(callCount, statusSequence.length - 1)];
      return { ok: status === 200, status, durationMs: 1, revisionAtCall: 1 };
    }),
    surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools: [] }),
    // Remaining methods unused in auth-probe tests
    surface_describe_tool: vi.fn(),
    surface_probe: vi.fn(),
    surface_sample_inputs: vi.fn(),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
    surface_list_pages: vi.fn(),
    surface_describe_self: vi.fn(),
    surface_describe_auth: vi.fn(),
    surface_list_navigations: vi.fn(),
    surface_enumerate_routes_runtime: vi.fn(),
    surface_postprocess_runtime_routes: vi.fn(),
  } as unknown as SurfaceMcpAdapter;
}

describe('runAuthProbes', () => {
  it('emits no_rate_limit_on_login when cap reached without 429', async () => {
    // All attempts return 401 (wrong creds, no rate limit)
    const surface = makeSurface(Array(55).fill(401));
    const result = await runAuthProbes({
      surface,
      loginToolId: 'login',
      maxAttempts: 5,
      delayOverrideMs: 0,
    });
    expect(result.detections).toHaveLength(1);
    expect(result.detections[0].kind).toBe('no_rate_limit_on_login');
    expect(result.detections[0].endpoint).toBe('login');
    expect(result.detections[0].rootCause).toContain('bogus-credential');
  });

  it('emits no detection when 429 observed before cap', async () => {
    // Returns 401 three times then 429
    const surface = makeSurface([401, 401, 401, 429]);
    const result = await runAuthProbes({
      surface,
      loginToolId: 'login',
      maxAttempts: 10,
      delayOverrideMs: 0,
    });
    expect(result.detections).toHaveLength(0);
  });

  it('emits no detection when 423 (account-locked) observed', async () => {
    const surface = makeSurface([401, 423]);
    const result = await runAuthProbes({
      surface,
      loginToolId: 'login',
      maxAttempts: 10,
      delayOverrideMs: 0,
    });
    expect(result.detections).toHaveLength(0);
  });

  it('caps at 50 regardless of maxAttempts', async () => {
    const calls: number[] = [];
    const surface = {
      surface_call: vi.fn().mockImplementation(async () => {
        calls.push(1);
        return { ok: false, status: 401, durationMs: 1, revisionAtCall: 1 };
      }),
      surface_list_tools: vi.fn().mockResolvedValue({ revision: 1, tools: [] }),
      surface_describe_tool: vi.fn(),
      surface_probe: vi.fn(),
      surface_sample_inputs: vi.fn(),
      surface_login_status: vi.fn(),
      surface_relogin: vi.fn(),
      surface_routes_for_page: vi.fn(),
      surface_list_pages: vi.fn(),
      surface_describe_self: vi.fn(),
      surface_describe_auth: vi.fn(),
      surface_list_navigations: vi.fn(),
      surface_enumerate_routes_runtime: vi.fn(),
      surface_postprocess_runtime_routes: vi.fn(),
    } as unknown as SurfaceMcpAdapter;

    await runAuthProbes({ surface, loginToolId: 'login', maxAttempts: 200, delayOverrideMs: 0 });
    // Should not exceed 50 login attempts + up to 5 rate-limit-discovery probes
    expect(calls.length).toBeLessThanOrEqual(55);
  }, 10000);

  it('returns rateLimitProfile from discovery', async () => {
    const surface = makeSurface([401, 429]);
    const result = await runAuthProbes({
      surface,
      loginToolId: 'login',
      maxAttempts: 10,
      delayOverrideMs: 0,
    });
    expect(result.rateLimitProfile).toBeDefined();
    expect(['observed', 'fallback']).toContain(result.rateLimitProfile.source);
  });
});
