// Tests for npm audit adapter (v0.5 T08).

import { describe, it, expect } from 'vitest';
import { npmAuditTool } from './npm-audit.js';

const FIXTURE_V7 = JSON.stringify({
  auditReportVersion: 2,
  vulnerabilities: {
    'lodash': {
      name: 'lodash',
      severity: 'high',
      isDirect: false,
      via: [],
      range: '<4.17.21',
    },
    'axios': {
      name: 'axios',
      severity: 'critical',
      isDirect: true,
      via: [],
      range: '<0.21.2',
    },
    'semver': {
      name: 'semver',
      severity: 'moderate',
      isDirect: false,
      via: [],
    },
  },
  metadata: {
    vulnerabilities: { high: 1, critical: 1 },
  },
});

const FIXTURE_V6 = JSON.stringify({
  advisories: {
    '1234': {
      id: 1234,
      module_name: 'node-fetch',
      title: 'Information Exposure',
      severity: 'high',
      url: 'https://npmjs.com/advisories/1234',
      via: [],
    },
    '5678': {
      id: 5678,
      module_name: 'mkdirp',
      title: 'Prototype Pollution',
      severity: 'moderate',
      url: 'https://npmjs.com/advisories/5678',
      via: [],
    },
  },
});

describe('npm-audit adapter', () => {
  it('parses v7 format into vulnerable_dependency_high detections', () => {
    const { detections, warnings } = npmAuditTool.parseStdout(FIXTURE_V7);
    expect(warnings).toHaveLength(0);
    // Only high and critical, not moderate
    expect(detections).toHaveLength(2);
    expect(detections.every(d => d.kind === 'vulnerable_dependency_high')).toBe(true);
    const names = detections.map(d => d.staticContext?.ruleId);
    expect(names).toContain('lodash');
    expect(names).toContain('axios');
    expect(names).not.toContain('semver');
  });

  it('parses v6 advisories format, filtering by severity', () => {
    const { detections, warnings } = npmAuditTool.parseStdout(FIXTURE_V6);
    expect(warnings).toHaveLength(0);
    expect(detections).toHaveLength(1);
    expect(detections[0].staticContext?.ruleId).toBe('1234');
    expect(detections[0].rootCause).toContain('node-fetch');
  });

  it('sets sourceFile to package-lock.json', () => {
    const { detections } = npmAuditTool.parseStdout(FIXTURE_V7);
    expect(detections.every(d => d.staticContext?.sourceFile === 'package-lock.json')).toBe(true);
  });

  it('generates correct args', () => {
    const args = npmAuditTool.args('/tmp/project');
    expect(args).toContain('audit');
    expect(args).toContain('--json');
    expect(args).toContain('--audit-level=high');
  });
});
