import { describe, it, expect } from 'vitest';
import {
  severityForCluster,
  severityToSarifLevel,
  severityToSarifSecurity,
  severityToGitlabSeverity,
  severityToLinearPriority,
  severityToJiraPriority,
  severityAtLeast,
} from '../src/export/severity.js';
import type { BugCluster } from '../src/types.js';

function makeCluster(overrides: Partial<BugCluster> = {}): Pick<BugCluster, 'kind' | 'severity'> {
  return {
    kind: 'idor_horizontal',
    severity: undefined,
    ...overrides,
  };
}

describe('severityForCluster', () => {
  it('returns cluster.severity when present', () => {
    const c = makeCluster({ severity: 'critical' });
    expect(severityForCluster(c)).toBe('critical');
  });

  it('falls back to registry for known kind', () => {
    // idor_horizontal is 'major' in registry
    const c = makeCluster({ kind: 'idor_horizontal', severity: undefined });
    expect(severityForCluster(c)).toBe('major');
  });

  it('returns info for unknown kind', () => {
    const c = makeCluster({ kind: 'totally_unknown_kind' as never, severity: undefined });
    expect(severityForCluster(c)).toBe('info');
  });
});

describe('severityToSarifLevel', () => {
  it('maps critical and major to error', () => {
    expect(severityToSarifLevel('critical')).toBe('error');
    expect(severityToSarifLevel('major')).toBe('error');
  });

  it('maps minor to warning', () => {
    expect(severityToSarifLevel('minor')).toBe('warning');
  });

  it('maps info to note', () => {
    expect(severityToSarifLevel('info')).toBe('note');
  });
});

describe('severityToSarifSecurity', () => {
  it('returns expected numeric strings', () => {
    expect(severityToSarifSecurity('critical')).toBe('9.5');
    expect(severityToSarifSecurity('major')).toBe('7.5');
    expect(severityToSarifSecurity('minor')).toBe('4.0');
    expect(severityToSarifSecurity('info')).toBe('1.0');
  });
});

describe('severityToGitlabSeverity', () => {
  it('maps correctly', () => {
    expect(severityToGitlabSeverity('critical')).toBe('Critical');
    expect(severityToGitlabSeverity('major')).toBe('High');
    expect(severityToGitlabSeverity('minor')).toBe('Medium');
    expect(severityToGitlabSeverity('info')).toBe('Info');
  });
});

describe('severityToLinearPriority', () => {
  it('maps critical to 1 (urgent)', () => {
    expect(severityToLinearPriority('critical')).toBe(1);
  });
  it('maps info to 4 (low)', () => {
    expect(severityToLinearPriority('info')).toBe(4);
  });
});

describe('severityToJiraPriority', () => {
  it('maps correctly', () => {
    expect(severityToJiraPriority('critical')).toBe('Highest');
    expect(severityToJiraPriority('major')).toBe('High');
    expect(severityToJiraPriority('minor')).toBe('Medium');
    expect(severityToJiraPriority('info')).toBe('Low');
  });
});

describe('severityAtLeast', () => {
  it('critical >= critical', () => expect(severityAtLeast('critical', 'critical')).toBe(true));
  it('critical >= major', () => expect(severityAtLeast('critical', 'major')).toBe(true));
  it('major is not >= critical', () => expect(severityAtLeast('major', 'critical')).toBe(false));
  it('info is not >= minor', () => expect(severityAtLeast('info', 'minor')).toBe(false));
  it('minor >= info', () => expect(severityAtLeast('minor', 'info')).toBe(true));
});
