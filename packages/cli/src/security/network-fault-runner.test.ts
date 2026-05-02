import { describe, it, expect } from 'vitest';
import {
  resolveFaultPerTestMaxMs,
  makeEmptyFaultTelemetry,
  addFaultSkip,
} from './network-fault-runner.js';

describe('resolveFaultPerTestMaxMs', () => {
  it('uses perTestMaxMs when explicitly set', () => {
    expect(resolveFaultPerTestMaxMs({ enabled: true, perTestMaxMs: 45_000 })).toBe(45_000);
  });

  it('computes from asyncMaxWaitMs * 1.5 when no explicit cap', () => {
    expect(resolveFaultPerTestMaxMs({ enabled: true, asyncMaxWaitMs: 30_000 })).toBe(45_000);
  });

  it('caps at 60_000ms regardless of asyncMaxWaitMs', () => {
    expect(resolveFaultPerTestMaxMs({ enabled: true, asyncMaxWaitMs: 60_000 })).toBe(60_000);
  });

  it('defaults to 45_000ms when no config provided', () => {
    expect(resolveFaultPerTestMaxMs({ enabled: true })).toBe(45_000);
  });
});

describe('makeEmptyFaultTelemetry', () => {
  it('returns zero-count telemetry', () => {
    const t = makeEmptyFaultTelemetry();
    expect(t.faultsAttempted).toBe(0);
    expect(t.faultsSucceeded).toBe(0);
    expect(t.faultsSkipped).toHaveLength(0);
    expect(t.retryStormsDetected).toBe(0);
  });
});

describe('addFaultSkip', () => {
  it('adds a new skip reason', () => {
    const t = makeEmptyFaultTelemetry();
    addFaultSkip(t, 'no_network_requests');
    expect(t.faultsSkipped).toHaveLength(1);
    expect(t.faultsSkipped[0]).toEqual({ reason: 'no_network_requests', count: 1 });
  });

  it('increments count for existing reason', () => {
    const t = makeEmptyFaultTelemetry();
    addFaultSkip(t, 'no_network_requests');
    addFaultSkip(t, 'no_network_requests');
    expect(t.faultsSkipped).toHaveLength(1);
    expect(t.faultsSkipped[0]?.count).toBe(2);
  });

  it('tracks multiple different reasons independently', () => {
    const t = makeEmptyFaultTelemetry();
    addFaultSkip(t, 'external_tool');
    addFaultSkip(t, 'no_network_requests');
    addFaultSkip(t, 'external_tool');
    expect(t.faultsSkipped).toHaveLength(2);
    const external = t.faultsSkipped.find(s => s.reason === 'external_tool');
    expect(external?.count).toBe(2);
  });
});
