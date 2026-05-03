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

  // back-compat: legacy boolean form is coerced to { enabled: <bool> }
  it('coerces raceConditions: true to { enabled: true }', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, raceConditions: true });
    expect(result.raceConditions?.enabled).toBe(true);
  });

  it('coerces raceConditions: false to { enabled: false }', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, raceConditions: false });
    expect(result.raceConditions?.enabled).toBe(false);
  });

  it('passes raceConditions object with variants unchanged', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, raceConditions: { enabled: true, variants: ['double_submit', 'cross_tab'] } });
    expect(result.raceConditions?.enabled).toBe(true);
    expect(result.raceConditions?.variants).toEqual(['double_submit', 'cross_tab']);
  });

  it('coerces multiContext: true to { enabled: true }', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, multiContext: true });
    expect(result.multiContext?.enabled).toBe(true);
  });

  it('coerces multiContext: false to { enabled: false }', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, multiContext: false });
    expect(result.multiContext?.enabled).toBe(false);
  });

  it('passes multiContext object with variants unchanged', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, multiContext: { enabled: true, n: 2 } });
    expect(result.multiContext?.enabled).toBe(true);
    expect(result.multiContext?.n).toBe(2);
  });

  it('coerces networkFaults: true to { enabled: true }', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, networkFaults: true });
    expect(result.networkFaults?.enabled).toBe(true);
  });

  it('coerces networkFaults: false to { enabled: false }', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, networkFaults: false });
    expect(result.networkFaults?.enabled).toBe(false);
  });

  it('passes networkFaults object with toolDenylist unchanged', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, networkFaults: { enabled: true, toolDenylist: ['POST /pay'] } });
    expect(result.networkFaults?.enabled).toBe(true);
    expect(result.networkFaults?.toolDenylist).toEqual(['POST /pay']);
  });

  it('coerces interactionPalette: true to { enabled: true }', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, interactionPalette: true });
    expect(result.interactionPalette?.enabled).toBe(true);
  });

  it('coerces interactionPalette: false to { enabled: false }', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, interactionPalette: false });
    expect(result.interactionPalette?.enabled).toBe(false);
  });

  it('passes interactionPalette object with maxTests unchanged', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, interactionPalette: { enabled: true, maxTests: 300 } });
    expect(result.interactionPalette?.enabled).toBe(true);
    expect(result.interactionPalette?.maxTests).toBe(300);
  });

  it('coerces authProbe: true to { enabled: true }', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, authProbe: true });
    expect(result.authProbe?.enabled).toBe(true);
  });

  it('coerces authProbe: false to { enabled: false }', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, authProbe: false });
    expect(result.authProbe?.enabled).toBe(false);
  });

  it('passes authProbe object with testAccountUsername unchanged', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, authProbe: { enabled: true, testAccountUsername: 'probe@test.invalid' } });
    expect(result.authProbe?.enabled).toBe(true);
    expect(result.authProbe?.testAccountUsername).toBe('probe@test.invalid');
  });

  it('coerces crossUser: true to enabled-with-defaults object', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, crossUser: true });
    expect(result.crossUser).toBeDefined();
    // boolean true → empty object (all defaults); crossRoleProbeEnabled is not forced off
    expect(result.crossUser?.crossRoleProbeEnabled).toBeUndefined();
    expect(result.crossUser?.anonymousProbeEnabled).toBeUndefined();
  });

  it('coerces crossUser: false to disabled object', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, crossUser: false });
    expect(result.crossUser?.crossRoleProbeEnabled).toBe(false);
    expect(result.crossUser?.anonymousProbeEnabled).toBe(false);
  });

  it('passes crossUser object unchanged', () => {
    const result = ConfigSchema.parse({ ...MINIMAL_VALID, crossUser: { crossRoleProbeEnabled: true, anonymousProbeEnabled: false, maxReplays: 200 } });
    expect(result.crossUser?.crossRoleProbeEnabled).toBe(true);
    expect(result.crossUser?.anonymousProbeEnabled).toBe(false);
    expect(result.crossUser?.maxReplays).toBe(200);
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
