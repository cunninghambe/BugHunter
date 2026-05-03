// Tests for #147: DETECTOR_REGISTRY defaultSeverity calibration.
// Verifies per-kind severity defaults and detection-level overrides.

import { describe, it, expect } from 'vitest';
import { severityForCluster } from '../src/export/severity.js';
import type { BugCluster } from '../src/types.js';

function makeCluster(kind: BugCluster['kind'], severity?: BugCluster['severity']): Pick<BugCluster, 'kind' | 'severity'> {
  return { kind, severity };
}

describe('DETECTOR_REGISTRY severity calibration (#147)', () => {
  it('missing_csp_header cluster has severity major', () => {
    expect(severityForCluster(makeCluster('missing_csp_header'))).toBe('major');
  });

  it('sql_injection cluster has severity critical', () => {
    expect(severityForCluster(makeCluster('sql_injection'))).toBe('critical');
  });

  it('command_injection cluster has severity critical', () => {
    expect(severityForCluster(makeCluster('command_injection'))).toBe('critical');
  });

  it('path_traversal cluster has severity critical', () => {
    expect(severityForCluster(makeCluster('path_traversal'))).toBe('critical');
  });

  it('xss_reflected cluster has severity critical', () => {
    expect(severityForCluster(makeCluster('xss_reflected'))).toBe('critical');
  });

  it('idor_horizontal_read cluster has severity critical', () => {
    expect(severityForCluster(makeCluster('idor_horizontal_read'))).toBe('critical');
  });

  it('auth_bypass_via_unauthed_route cluster has severity critical', () => {
    expect(severityForCluster(makeCluster('auth_bypass_via_unauthed_route'))).toBe('critical');
  });

  it('coop_coep_violation cluster has severity major', () => {
    expect(severityForCluster(makeCluster('coop_coep_violation'))).toBe('major');
  });

  it('oversized_bundle cluster has severity major', () => {
    expect(severityForCluster(makeCluster('oversized_bundle'))).toBe('major');
  });

  it('slow_lcp cluster has severity major', () => {
    expect(severityForCluster(makeCluster('slow_lcp'))).toBe('major');
  });

  it('high_cls cluster has severity major', () => {
    expect(severityForCluster(makeCluster('high_cls'))).toBe('major');
  });

  it('keyboard_trap cluster has severity major', () => {
    expect(severityForCluster(makeCluster('keyboard_trap'))).toBe('major');
  });

  it('seo_meta_description_missing cluster has severity minor', () => {
    expect(severityForCluster(makeCluster('seo_meta_description_missing'))).toBe('minor');
  });

  it('seo_h1_missing_or_multiple cluster has severity minor', () => {
    expect(severityForCluster(makeCluster('seo_h1_missing_or_multiple'))).toBe('minor');
  });

  it('image_missing_alt cluster has severity minor', () => {
    expect(severityForCluster(makeCluster('image_missing_alt'))).toBe('minor');
  });

  it('focus_lost_after_action cluster has severity minor', () => {
    expect(severityForCluster(makeCluster('focus_lost_after_action'))).toBe('minor');
  });

  it('request_dedup_missing cluster has severity minor', () => {
    expect(severityForCluster(makeCluster('request_dedup_missing'))).toBe('minor');
  });

  it('explicit detection.severity overrides registry default', () => {
    // missing_csp_header default is major, but explicit critical should win
    const cluster = makeCluster('missing_csp_header', 'critical');
    expect(severityForCluster(cluster)).toBe('critical');
  });

  it('explicit detection.severity of info overrides a critical registry default', () => {
    // sql_injection default is critical, but explicit info should win
    const cluster = makeCluster('sql_injection', 'info');
    expect(severityForCluster(cluster)).toBe('info');
  });
});
