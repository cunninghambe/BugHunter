import { describe, it, expect } from 'vitest';
import { ConfigSchema } from '../src/config.js';

const MINIMAL_VALID = {
  projectName: 'test-project',
  surfaceMcpUrl: 'http://localhost:4000',
};

describe('ConfigSchema feature flag declarations', () => {
  it('passes raceConditions through parse', () => {
    const input = {
      ...MINIMAL_VALID,
      raceConditions: {
        enabled: true,
        variants: ['double_submit', 'interleaved_mutations'],
        maxTests: 100,
        doubleSubmitGapMs: 50,
        consensusRuns: 3,
        strict: false,
      },
    };
    const result = ConfigSchema.parse(input);
    expect(result.raceConditions?.enabled).toBe(true);
    expect(result.raceConditions?.variants).toEqual(['double_submit', 'interleaved_mutations']);
    expect(result.raceConditions?.maxTests).toBe(100);
  });

  it('passes multiContext through parse', () => {
    const input = {
      ...MINIMAL_VALID,
      multiContext: {
        enabled: true,
        n: 3,
        variants: ['state_divergence', 'lifecycle_state_loss'],
        lifecycleEvents: ['visibilitychange', 'freeze'],
        multiContextConcurrency: 1,
      },
    };
    const result = ConfigSchema.parse(input);
    expect(result.multiContext?.enabled).toBe(true);
    expect(result.multiContext?.n).toBe(3);
    expect(result.multiContext?.variants).toEqual(['state_divergence', 'lifecycle_state_loss']);
  });

  it('passes networkFaults through parse', () => {
    const input = {
      ...MINIMAL_VALID,
      networkFaults: {
        enabled: true,
        toolDenylist: ['POST /api/payment'],
        maxFaultTests: 200,
        includeNavigation: false,
      },
    };
    const result = ConfigSchema.parse(input);
    expect(result.networkFaults?.enabled).toBe(true);
    expect(result.networkFaults?.toolDenylist).toEqual(['POST /api/payment']);
  });

  it('passes all three flags together', () => {
    const input = {
      ...MINIMAL_VALID,
      raceConditions: { enabled: true },
      multiContext: { enabled: true },
      networkFaults: { enabled: true },
    };
    const result = ConfigSchema.parse(input);
    expect(result.raceConditions?.enabled).toBe(true);
    expect(result.multiContext?.enabled).toBe(true);
    expect(result.networkFaults?.enabled).toBe(true);
  });

  it('passes readOnly through parse', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, readOnly: true });
    expect(result.readOnly).toBe(true);
  });

  it('passes localeStress through parse', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, localeStress: true });
    expect(result.localeStress).toBe(true);
  });

  it('passes interactionPalette through parse', () => {
    const input = {
      ...MINIMAL_VALID,
      interactionPalette: { enabled: true, maxTests: 300, visionThreshold: 0.18 },
    };
    const result = ConfigSchema.parse(input);
    expect(result.interactionPalette?.enabled).toBe(true);
    expect(result.interactionPalette?.maxTests).toBe(300);
  });

  it('passes authProbe through parse', () => {
    const input = {
      ...MINIMAL_VALID,
      authProbe: { enabled: true, maxAttempts: 50, testAccountUsername: 'probe@test.invalid' },
    };
    const result = ConfigSchema.parse(input);
    expect(result.authProbe?.enabled).toBe(true);
    expect(result.authProbe?.testAccountUsername).toBe('probe@test.invalid');
  });

  it('passes crossUser through parse', () => {
    const input = {
      ...MINIMAL_VALID,
      crossUser: { crossRoleProbeEnabled: true, anonymousProbeEnabled: false, maxReplays: 200 },
    };
    const result = ConfigSchema.parse(input);
    expect(result.crossUser?.crossRoleProbeEnabled).toBe(true);
    expect(result.crossUser?.anonymousProbeEnabled).toBe(false);
  });

  it('strips unknown top-level keys', () => {
    const input = { ...MINIMAL_VALID, thisKeyDoesNotExist: true };
    const result = ConfigSchema.parse(input);
    expect((result as Record<string, unknown>)['thisKeyDoesNotExist']).toBeUndefined();
  });

  it('rejects invalid raceConditions variant name', () => {
    const input = {
      ...MINIMAL_VALID,
      raceConditions: { enabled: true, variants: ['not_a_real_variant'] },
    };
    expect(() => ConfigSchema.parse(input)).toThrow();
  });

  it('rejects invalid networkFaults variant kind', () => {
    const input = {
      ...MINIMAL_VALID,
      networkFaults: { enabled: true, variants: [{ kind: 'alien_fault' }] },
    };
    expect(() => ConfigSchema.parse(input)).toThrow();
  });
});
