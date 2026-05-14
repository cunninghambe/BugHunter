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
    const { detections, warnings } = npmAuditTool.parseStdout(FIXTURE_V7, "/tmp");
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
    const { detections, warnings } = npmAuditTool.parseStdout(FIXTURE_V6, "/tmp");
    expect(warnings).toHaveLength(0);
    expect(detections).toHaveLength(1);
    expect(detections[0].staticContext?.ruleId).toBe('1234');
    expect(detections[0].rootCause).toContain('node-fetch');
  });

  it('sets sourceFile to package-lock.json', () => {
    const { detections } = npmAuditTool.parseStdout(FIXTURE_V7, "/tmp");
    expect(detections.every(d => d.staticContext?.sourceFile === 'package-lock.json')).toBe(true);
  });

  it('generates correct args', () => {
    const args = npmAuditTool.args('/tmp/project');
    expect(args).toContain('audit');
    expect(args).toContain('--json');
    expect(args).toContain('--audit-level=high');
  });
});

describe('npm-audit adapter — v0.51 transitive collapse', () => {
  it('collapses a transitive vuln into its direct parent (1 emission instead of 2)', () => {
    // Models spoonworks shape: @sentry/nextjs (direct, high) pulls in rollup (transitive, high)
    const fixture = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        '@sentry/nextjs': {
          name: '@sentry/nextjs', severity: 'high', isDirect: true, via: ['rollup'],
        },
        'rollup': {
          name: 'rollup', severity: 'high', isDirect: false, via: [],
        },
      },
    });
    const { detections } = npmAuditTool.parseStdout(fixture, "/tmp");
    expect(detections).toHaveLength(1);
    expect(detections[0].staticContext?.ruleId).toBe('@sentry/nextjs');
    expect(detections[0].rootCause).toContain('pulls in vulnerable: rollup');
  });

  it('collapses multiple transitives into one direct parent', () => {
    const fixture = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        '@sentry/nextjs': {
          name: '@sentry/nextjs', severity: 'high', isDirect: true, via: ['rollup', 'glob'],
        },
        'rollup': { name: 'rollup', severity: 'high', isDirect: false, via: [] },
        'glob':   { name: 'glob',   severity: 'high', isDirect: false, via: [] },
      },
    });
    const { detections } = npmAuditTool.parseStdout(fixture, "/tmp");
    expect(detections).toHaveLength(1);
    expect(detections[0].rootCause).toContain('glob');
    expect(detections[0].rootCause).toContain('rollup');
  });

  it('emits transitives separately when no direct parent traces to them (graph partial)', () => {
    // Transitive with no `via` chain pointing to it — emit standalone.
    const fixture = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        'orphan-pkg': { name: 'orphan-pkg', severity: 'high', isDirect: false, via: [] },
      },
    });
    const { detections } = npmAuditTool.parseStdout(fixture, "/tmp");
    expect(detections).toHaveLength(1);
    expect(detections[0].staticContext?.ruleId).toBe('orphan-pkg');
    expect(detections[0].rootCause).toContain('transitive; no direct parent');
  });

  it('emits two clusters for two separate direct vulns each with their own transitives', () => {
    const fixture = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        '@sentry/nextjs': { name: '@sentry/nextjs', severity: 'high',     isDirect: true, via: ['rollup'] },
        'next':           { name: 'next',           severity: 'critical', isDirect: true, via: ['glob'] },
        'rollup':         { name: 'rollup',         severity: 'high',     isDirect: false, via: [] },
        'glob':           { name: 'glob',           severity: 'high',     isDirect: false, via: [] },
      },
    });
    const { detections } = npmAuditTool.parseStdout(fixture, "/tmp");
    expect(detections).toHaveLength(2);
    const sentry = detections.find(d => d.staticContext?.ruleId === '@sentry/nextjs');
    const next   = detections.find(d => d.staticContext?.ruleId === 'next');
    expect(sentry?.rootCause).toContain('rollup');
    expect(next?.rootCause).toContain('glob');
  });

  it('walks via chain transitively (grandparent: direct → mid-transitive → leaf-transitive)', () => {
    const fixture = JSON.stringify({
      auditReportVersion: 2,
      vulnerabilities: {
        'parent': { name: 'parent', severity: 'high', isDirect: true,  via: ['middle'] },
        'middle': { name: 'middle', severity: 'high', isDirect: false, via: ['leaf'] },
        'leaf':   { name: 'leaf',   severity: 'high', isDirect: false, via: [] },
      },
    });
    const { detections } = npmAuditTool.parseStdout(fixture, "/tmp");
    expect(detections).toHaveLength(1);
    expect(detections[0].staticContext?.ruleId).toBe('parent');
    expect(detections[0].rootCause).toContain('leaf');
    expect(detections[0].rootCause).toContain('middle');
  });
});
