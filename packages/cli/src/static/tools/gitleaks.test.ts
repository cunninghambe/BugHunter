// Tests for gitleaks adapter (v0.5 T07).

import { describe, it, expect } from 'vitest';
import { gitleaksTool } from './gitleaks.js';

const FIXTURE_OUTPUT = JSON.stringify([
  {
    RuleID: 'generic-api-key',
    File: 'src/config/secrets.ts',
    StartLine: 42,
    Secret: 'AKIAIOSFODNN7EXAMPLE',
    Match: 'AWS_KEY=AKIAIOSFODNN7EXAMPLE',
    Description: 'Generic API Key',
  },
  {
    RuleID: 'stripe-access-token',
    File: 'tests/fixtures/stripe.json',
    StartLine: 7,
    Secret: 'sk_live_test_fake_key',
    Match: '"secret": "sk_live_test_fake_key"',
  },
]);

describe('gitleaks adapter', () => {
  it('parses fixture output into hardcoded_credentials_in_source detections', () => {
    const { detections, warnings } = gitleaksTool.parseStdout(FIXTURE_OUTPUT, "/tmp");
    expect(warnings).toHaveLength(0);
    expect(detections).toHaveLength(2);
    expect(detections[0].kind).toBe('hardcoded_credentials_in_source');
    expect(detections[0].staticContext?.tool).toBe('gitleaks');
    expect(detections[0].staticContext?.ruleId).toBe('generic-api-key');
    expect(detections[0].staticContext?.sourceFile).toBe('src/config/secrets.ts');
    expect(detections[0].staticContext?.sourceLine).toBe(42);
  });

  it('returns empty detections and warning on schema mismatch', () => {
    const { detections, warnings } = gitleaksTool.parseStdout(JSON.stringify([{ BadField: true }]), "/tmp");
    // RuleID and File are required — should fail parse → warning returned
    expect(detections).toHaveLength(0);
    expect(warnings[0]).toMatch(/gitleaks schema parse error/);
  });

  it('tool is marked optional (missing binary is not fatal)', () => {
    expect(gitleaksTool.optional).toBe(true);
  });

  it('generates correct args for a project dir', () => {
    const args = gitleaksTool.args('/tmp/myproject');
    expect(args).toContain('--source');
    expect(args).toContain('/tmp/myproject');
    expect(args).toContain('--report-format');
    expect(args).toContain('json');
  });
});
