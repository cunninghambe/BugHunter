// Tests for eslint-no-empty adapter (v0.5 T10).

import { describe, it, expect } from 'vitest';
import { eslintNoEmptyTool } from './eslint-no-empty.js';

const FIXTURE = JSON.stringify([
  {
    filePath: '/app/src/utils/auth.ts',
    messages: [
      {
        ruleId: 'no-empty',
        severity: 2,
        message: 'Empty block statement.',
        line: 23,
        column: 3,
        nodeType: 'BlockStatement',
      },
      {
        ruleId: 'no-unused-vars',
        severity: 1,
        message: "'x' is defined but never used.",
        line: 10,
        column: 7,
      },
    ],
    errorCount: 1,
    warningCount: 1,
  },
  {
    filePath: '/app/src/api/handler.ts',
    messages: [
      {
        ruleId: 'no-empty',
        severity: 2,
        message: 'Empty block statement.',
        line: 55,
        column: 5,
      },
    ],
    errorCount: 1,
    warningCount: 0,
  },
]);

describe('eslint-no-empty adapter', () => {
  it('emits swallowed_error_empty_catch only for no-empty violations', () => {
    const { detections, warnings } = eslintNoEmptyTool.parseStdout(FIXTURE, "/tmp");
    expect(warnings).toHaveLength(0);
    expect(detections).toHaveLength(2);
    expect(detections.every(d => d.kind === 'swallowed_error_empty_catch')).toBe(true);
  });

  it('ignores non-no-empty violations', () => {
    const { detections } = eslintNoEmptyTool.parseStdout(FIXTURE, "/tmp");
    const rules = detections.map(d => d.staticContext?.ruleId);
    expect(rules.every(r => r === 'no-empty')).toBe(true);
  });

  it('populates staticContext correctly', () => {
    const { detections } = eslintNoEmptyTool.parseStdout(FIXTURE, "/tmp");
    const first = detections[0];
    expect(first.staticContext?.tool).toBe('eslint-no-empty');
    expect(first.staticContext?.sourceFile).toBe('/app/src/utils/auth.ts');
    expect(first.staticContext?.sourceLine).toBe(23);
  });

  it('returns warning on schema mismatch', () => {
    const { detections, warnings } = eslintNoEmptyTool.parseStdout(JSON.stringify({ not: 'an array' }), "/tmp");
    expect(detections).toHaveLength(0);
    expect(warnings[0]).toMatch(/eslint-no-empty schema parse error/);
  });

  it('is marked optional', () => {
    expect(eslintNoEmptyTool.optional).toBe(true);
  });

  it('generates correct args', () => {
    const args = eslintNoEmptyTool.args('/tmp/project');
    expect(args).toContain('--no-eslintrc');
    expect(args).toContain('--format');
    expect(args).toContain('json');
  });
});
