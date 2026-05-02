// Tests for classify phase — v0.36 browser-platform BugKind ordering.

import { describe, it, expect } from 'vitest';
import { runClassify } from './classify.js';
import type { TestResult, BugDetection } from '../types.js';

function makeResult(bugs: BugDetection[]): TestResult {
  return {
    testId: `test-${Math.random().toString(36).slice(2)}`,
    occurrenceId: `occ-${Math.random().toString(36).slice(2)}`,
    passed: bugs.length === 0,
    durationMs: 0,
    bugs,
  };
}

function makeDetection(kind: BugDetection['kind']): BugDetection {
  return { kind, rootCause: `test ${kind}` };
}

describe('runClassify — v0.36 browser-platform kinds', () => {
  it('classifies service_worker_stale as a bug', () => {
    const result = makeResult([makeDetection('service_worker_stale')]);
    const { bugs } = runClassify([result]);
    expect(bugs).toHaveLength(1);
    expect(bugs[0].detection.kind).toBe('service_worker_stale');
  });

  it('classifies web_worker_error as a bug', () => {
    const result = makeResult([makeDetection('web_worker_error')]);
    const { bugs } = runClassify([result]);
    expect(bugs[0].detection.kind).toBe('web_worker_error');
  });

  it('classifies iframe_postmessage_unguarded as a bug', () => {
    const result = makeResult([makeDetection('iframe_postmessage_unguarded')]);
    const { bugs } = runClassify([result]);
    expect(bugs[0].detection.kind).toBe('iframe_postmessage_unguarded');
  });

  it('classifies shadow_dom_a11y_violation as a bug', () => {
    const result = makeResult([makeDetection('shadow_dom_a11y_violation')]);
    const { bugs } = runClassify([result]);
    expect(bugs[0].detection.kind).toBe('shadow_dom_a11y_violation');
  });

  it('classifies permission_denied_unhandled as a bug', () => {
    const result = makeResult([makeDetection('permission_denied_unhandled')]);
    const { bugs } = runClassify([result]);
    expect(bugs[0].detection.kind).toBe('permission_denied_unhandled');
  });

  it('classifies webrtc_ice_failure as a bug', () => {
    const result = makeResult([makeDetection('webrtc_ice_failure')]);
    const { bugs } = runClassify([result]);
    expect(bugs[0].detection.kind).toBe('webrtc_ice_failure');
  });

  it('classifies subresource_integrity_violation as a bug', () => {
    const result = makeResult([makeDetection('subresource_integrity_violation')]);
    const { bugs } = runClassify([result]);
    expect(bugs[0].detection.kind).toBe('subresource_integrity_violation');
  });

  it('classifies coop_coep_violation as a bug', () => {
    const result = makeResult([makeDetection('coop_coep_violation')]);
    const { bugs } = runClassify([result]);
    expect(bugs[0].detection.kind).toBe('coop_coep_violation');
  });

  it('classifies trusted_types_violation as a bug', () => {
    const result = makeResult([makeDetection('trusted_types_violation')]);
    const { bugs } = runClassify([result]);
    expect(bugs[0].detection.kind).toBe('trusted_types_violation');
  });

  it('trusted_types_violation ranks above web_worker_error when co-detected', () => {
    // Both in same result — classify picks highest priority
    const result = makeResult([
      makeDetection('web_worker_error'),
      makeDetection('trusted_types_violation'),
    ]);
    const { bugs } = runClassify([result]);
    // Only 1 bug per test result (highest priority wins)
    expect(bugs).toHaveLength(1);
    expect(bugs[0].detection.kind).toBe('trusted_types_violation');
  });

  it('web_worker_error ranks above iframe_postmessage_unguarded when co-detected', () => {
    const result = makeResult([
      makeDetection('iframe_postmessage_unguarded'),
      makeDetection('web_worker_error'),
    ]);
    const { bugs } = runClassify([result]);
    expect(bugs).toHaveLength(1);
    expect(bugs[0].detection.kind).toBe('web_worker_error');
  });

  it('service_worker_stale ranks above network_5xx when co-detected (per priority list)', () => {
    const result = makeResult([
      makeDetection('network_5xx'),
      makeDetection('service_worker_stale'),
    ]);
    const { bugs } = runClassify([result]);
    expect(bugs).toHaveLength(1);
    expect(bugs[0].detection.kind).toBe('service_worker_stale');
  });
});
