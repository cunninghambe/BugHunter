// Tests for semgrep adapter (v0.5 T09).

import { describe, it, expect } from 'vitest';
import { semgrepTool } from './semgrep.js';

const FIXTURE_SECRETS = JSON.stringify({
  results: [
    {
      check_id: 'secrets.generic-api-key',
      path: 'src/config/db.ts',
      start: { line: 12 },
      end: { line: 12 },
      extra: { message: 'Generic API key detected', severity: 'ERROR' },
    },
    {
      check_id: 'javascript.lang.security.audit.dangerous-exec',
      path: 'src/utils/exec.ts',
      start: { line: 45 },
      extra: { message: 'Dangerous exec call', severity: 'WARNING' },
    },
    {
      check_id: 'generic.secrets.stripe-api-key',
      path: 'src/payments/config.ts',
      start: { line: 3 },
      extra: { message: 'Stripe API key', severity: 'ERROR' },
    },
  ],
  errors: [],
});

describe('semgrep adapter', () => {
  it('emits hardcoded_credentials_in_source only for secrets rules', () => {
    const { detections, warnings } = semgrepTool.parseStdout(FIXTURE_SECRETS);
    expect(warnings).toHaveLength(0);
    expect(detections).toHaveLength(2);
    expect(detections.every(d => d.kind === 'hardcoded_credentials_in_source')).toBe(true);
  });

  it('skips non-secrets rules', () => {
    const { detections } = semgrepTool.parseStdout(FIXTURE_SECRETS);
    const ruleIds = detections.map(d => d.staticContext?.ruleId);
    expect(ruleIds).not.toContain('javascript.lang.security.audit.dangerous-exec');
  });

  it('populates staticContext correctly', () => {
    const { detections } = semgrepTool.parseStdout(FIXTURE_SECRETS);
    const first = detections[0];
    expect(first.staticContext?.tool).toBe('semgrep');
    expect(first.staticContext?.ruleId).toBe('secrets.generic-api-key');
    expect(first.staticContext?.sourceFile).toBe('src/config/db.ts');
    expect(first.staticContext?.sourceLine).toBe(12);
  });

  it('returns warning on schema mismatch', () => {
    const { detections, warnings } = semgrepTool.parseStdout(JSON.stringify({ bad: 'field' }));
    expect(detections).toHaveLength(0);
    expect(warnings[0]).toMatch(/semgrep schema parse error/);
  });

  it('is marked optional', () => {
    expect(semgrepTool.optional).toBe(true);
  });

  it('generates correct semgrep args', () => {
    const args = semgrepTool.args('/tmp/project');
    expect(args).toContain('--config=p/secrets');
    expect(args).toContain('--json');
    expect(args).toContain('--severity=ERROR');
  });
});
