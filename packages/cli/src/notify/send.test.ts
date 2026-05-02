// v0.48: Notification system tests.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { interpolateEnv, interpolateChannel, buildPayload } from './send.js';
import { ChannelTargetSchema, NotificationsConfigSchema } from './types.js';
import type { BugCluster, CrossRunSummary } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makecluster(overrides: Partial<BugCluster> = {}): BugCluster {
  return {
    id: 'c1',
    runId: 'run-1',
    kind: 'console_error',
    rootCause: 'Something went wrong',
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    clusterSize: 1,
    occurrences: [],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
    severity: 'minor',
    ...overrides,
  };
}

const crossRun: CrossRunSummary = {
  previousRunId: 'run-0',
  newBugs: 2,
  persistent: 1,
  goneSinceLast: 0,
  regressed: 0,
};

// ---------------------------------------------------------------------------
// interpolateEnv
// ---------------------------------------------------------------------------

describe('interpolateEnv', () => {
  beforeEach(() => {
    process.env['TEST_VAR'] = 'hello';
  });

  afterEach(() => {
    delete process.env['TEST_VAR'];
  });

  it('replaces a defined env var', () => {
    expect(interpolateEnv('https://example.com/${TEST_VAR}/path')).toBe('https://example.com/hello/path');
  });

  it('throws on undefined env var', () => {
    expect(() => interpolateEnv('${UNDEFINED_VAR_XYZ}')).toThrow('UNDEFINED_VAR_XYZ');
  });

  it('returns unchanged string with no placeholders', () => {
    expect(interpolateEnv('https://example.com/')).toBe('https://example.com/');
  });

  it('replaces multiple env vars in one string', () => {
    process.env['VAR_A'] = 'foo';
    process.env['VAR_B'] = 'bar';
    expect(interpolateEnv('${VAR_A}-${VAR_B}')).toBe('foo-bar');
    delete process.env['VAR_A'];
    delete process.env['VAR_B'];
  });
});

// ---------------------------------------------------------------------------
// interpolateChannel
// ---------------------------------------------------------------------------

describe('interpolateChannel', () => {
  beforeEach(() => {
    process.env['HOOK_URL'] = 'https://hooks.example.com/abc';
  });

  afterEach(() => {
    delete process.env['HOOK_URL'];
  });

  it('interpolates webhook URL', () => {
    const ch = interpolateChannel({ kind: 'webhook', url: '${HOOK_URL}' });
    expect(ch).toMatchObject({ kind: 'webhook', url: 'https://hooks.example.com/abc' });
  });

  it('interpolates webhook headers', () => {
    process.env['MY_TOKEN'] = 'secret';
    const ch = interpolateChannel({
      kind: 'webhook',
      url: 'https://example.com',
      headers: { Authorization: 'Bearer ${MY_TOKEN}' },
    });
    expect(ch).toMatchObject({ headers: { Authorization: 'Bearer secret' } });
    delete process.env['MY_TOKEN'];
  });

  it('interpolates slack-webhook URL', () => {
    const ch = interpolateChannel({ kind: 'slack-webhook', url: '${HOOK_URL}' });
    expect(ch).toMatchObject({ url: 'https://hooks.example.com/abc' });
  });

  it('interpolates discord-webhook URL', () => {
    const ch = interpolateChannel({ kind: 'discord-webhook', url: '${HOOK_URL}' });
    expect(ch).toMatchObject({ url: 'https://hooks.example.com/abc' });
  });

  it('interpolates slack-channel channel field', () => {
    process.env['MY_CHANNEL'] = '#alerts';
    const ch = interpolateChannel({ kind: 'slack-channel', channel: '${MY_CHANNEL}' });
    expect(ch).toMatchObject({ channel: '#alerts' });
    delete process.env['MY_CHANNEL'];
  });

  it('interpolates email to field', () => {
    process.env['ALERT_EMAIL'] = 'ops@example.com';
    const ch = interpolateChannel({ kind: 'email', to: '${ALERT_EMAIL}' });
    expect(ch).toMatchObject({ to: 'ops@example.com' });
    delete process.env['ALERT_EMAIL'];
  });
});

// ---------------------------------------------------------------------------
// ChannelTargetSchema
// ---------------------------------------------------------------------------

describe('ChannelTargetSchema', () => {
  it('accepts a valid webhook', () => {
    const r = ChannelTargetSchema.safeParse({ kind: 'webhook', url: 'https://example.com' });
    expect(r.success).toBe(true);
  });

  it('accepts a slack-channel with triggers', () => {
    const r = ChannelTargetSchema.safeParse({
      kind: 'slack-channel',
      channel: '#bugs',
      triggers: ['critical', 'summary'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown kind', () => {
    const r = ChannelTargetSchema.safeParse({ kind: 'unknown', url: 'https://example.com' });
    expect(r.success).toBe(false);
  });

  it('rejects email with empty to', () => {
    const r = ChannelTargetSchema.safeParse({ kind: 'email', to: '' });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// NotificationsConfigSchema
// ---------------------------------------------------------------------------

describe('NotificationsConfigSchema', () => {
  it('accepts minimal valid config', () => {
    const r = NotificationsConfigSchema.safeParse({
      channels: [{ kind: 'webhook', url: 'https://example.com' }],
    });
    expect(r.success).toBe(true);
  });

  it('rejects empty channels array', () => {
    const r = NotificationsConfigSchema.safeParse({ channels: [] });
    expect(r.success).toBe(false);
  });

  it('accepts all trigger types', () => {
    const r = NotificationsConfigSchema.safeParse({
      channels: [{ kind: 'webhook', url: 'https://example.com' }],
      defaultTriggers: ['critical', 'regressed', 'fixVerified', 'summary'],
    });
    expect(r.success).toBe(true);
  });

  it('rejects unknown trigger', () => {
    const r = NotificationsConfigSchema.safeParse({
      channels: [{ kind: 'webhook', url: 'https://example.com' }],
      defaultTriggers: ['unknown-trigger'],
    });
    expect(r.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildPayload
// ---------------------------------------------------------------------------

describe('buildPayload', () => {
  it('caps criticalBugs at 25 and sets truncated=true', () => {
    const clusters = Array.from({ length: 30 }, (_, i) => makecluster({ id: `c${i}`, severity: 'major' }));
    const payload = buildPayload({
      trigger: 'summary',
      runId: 'run-1',
      projectName: 'test-project',
      clusters,
      bySeverity: { major: 30 },
      byKind: { console_error: 30 },
      crossRun: undefined,
      actualRuntimeMs: 1000,
    });
    expect(payload.criticalBugs).toHaveLength(25);
    expect(payload.truncated).toBe(true);
    expect(payload.bugsTotal).toBe(30);
  });

  it('sets truncated=false when <= 25 clusters', () => {
    const clusters = [makecluster()];
    const payload = buildPayload({
      trigger: 'summary',
      runId: 'run-1',
      projectName: 'test-project',
      clusters,
      bySeverity: { minor: 1 },
      byKind: { console_error: 1 },
      crossRun: undefined,
      actualRuntimeMs: 500,
    });
    expect(payload.truncated).toBe(false);
    expect(payload.criticalBugs).toHaveLength(1);
  });

  it('sorts criticalBugs by severity desc (critical first)', () => {
    const clusters = [
      makecluster({ id: 'a', severity: 'info' }),
      makecluster({ id: 'b', severity: 'critical' }),
      makecluster({ id: 'c', severity: 'major' }),
    ];
    const payload = buildPayload({
      trigger: 'summary',
      runId: 'run-1',
      projectName: 'test-project',
      clusters,
      bySeverity: {},
      byKind: {},
      crossRun: undefined,
      actualRuntimeMs: 1000,
    });
    expect(payload.criticalBugs[0].severity).toBe('critical');
    expect(payload.criticalBugs[1].severity).toBe('major');
    expect(payload.criticalBugs[2].severity).toBe('info');
  });

  it('sets crossRun to null when undefined', () => {
    const payload = buildPayload({
      trigger: 'summary',
      runId: 'run-1',
      projectName: 'proj',
      clusters: [],
      bySeverity: {},
      byKind: {},
      crossRun: undefined,
      actualRuntimeMs: 100,
    });
    expect(payload.crossRun).toBeNull();
  });

  it('includes crossRun data when present', () => {
    const payload = buildPayload({
      trigger: 'summary',
      runId: 'run-1',
      projectName: 'proj',
      clusters: [],
      bySeverity: {},
      byKind: {},
      crossRun,
      actualRuntimeMs: 100,
    });
    expect(payload.crossRun).toMatchObject({ newBugs: 2, regressed: 0 });
  });
});

// ---------------------------------------------------------------------------
// fireNotifications — dry-run mode
// ---------------------------------------------------------------------------

describe('fireNotifications dry-run', () => {
  it('returns dry-run results without making network calls', async () => {
    const { fireNotifications } = await import('./send.js');
    const fetchSpy = vi.spyOn(global, 'fetch');

    const results = await fireNotifications({
      config: {
        channels: [
          { kind: 'webhook', url: 'https://example.com/hook' },
        ],
        defaultTriggers: ['summary'],
      },
      projectDir: '/tmp/test-project',
      runId: 'run-1',
      projectName: 'test-project',
      clusters: [makecluster()],
      bySeverity: { minor: 1 },
      byKind: { console_error: 1 },
      crossRun: undefined,
      actualRuntimeMs: 1000,
      dryRun: true,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
    expect(results[0].channelKind).toBe('webhook');

    fetchSpy.mockRestore();
  });

  it('fires critical trigger only when a critical cluster is present', async () => {
    const { fireNotifications } = await import('./send.js');

    const results = await fireNotifications({
      config: {
        channels: [
          { kind: 'webhook', url: 'https://example.com/hook', triggers: ['critical'] },
        ],
      },
      projectDir: '/tmp/test-project',
      runId: 'run-1',
      projectName: 'test-project',
      clusters: [makecluster({ severity: 'critical' })],
      bySeverity: { critical: 1 },
      byKind: { console_error: 1 },
      crossRun: undefined,
      actualRuntimeMs: 1000,
      dryRun: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].trigger).toBe('critical');
  });

  it('does not fire critical trigger when no critical clusters', async () => {
    const { fireNotifications } = await import('./send.js');

    const results = await fireNotifications({
      config: {
        channels: [
          { kind: 'webhook', url: 'https://example.com/hook', triggers: ['critical'] },
        ],
      },
      projectDir: '/tmp/test-project',
      runId: 'run-1',
      projectName: 'test-project',
      clusters: [makecluster({ severity: 'minor' })],
      bySeverity: { minor: 1 },
      byKind: { console_error: 1 },
      crossRun: undefined,
      actualRuntimeMs: 1000,
      dryRun: true,
    });

    expect(results).toHaveLength(0);
  });

  it('fires regressed trigger when crossRun.regressed > 0', async () => {
    const { fireNotifications } = await import('./send.js');

    const results = await fireNotifications({
      config: {
        channels: [
          { kind: 'webhook', url: 'https://example.com/hook', triggers: ['regressed'] },
        ],
      },
      projectDir: '/tmp/test-project',
      runId: 'run-1',
      projectName: 'test-project',
      clusters: [],
      bySeverity: {},
      byKind: {},
      crossRun: { previousRunId: 'run-0', newBugs: 0, persistent: 0, goneSinceLast: 0, regressed: 3 },
      actualRuntimeMs: 1000,
      dryRun: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].trigger).toBe('regressed');
  });

  it('fires summary trigger regardless of cluster content', async () => {
    const { fireNotifications } = await import('./send.js');

    const results = await fireNotifications({
      config: {
        channels: [
          { kind: 'webhook', url: 'https://example.com/hook', triggers: ['summary'] },
        ],
      },
      projectDir: '/tmp/test-project',
      runId: 'run-1',
      projectName: 'test-project',
      clusters: [],
      bySeverity: {},
      byKind: {},
      crossRun: undefined,
      actualRuntimeMs: 1000,
      dryRun: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0].trigger).toBe('summary');
  });

  it('returns empty array when no channels match active triggers', async () => {
    const { fireNotifications } = await import('./send.js');

    const results = await fireNotifications({
      config: {
        channels: [
          { kind: 'webhook', url: 'https://example.com/hook', triggers: ['regressed'] },
        ],
      },
      projectDir: '/tmp/test-project',
      runId: 'run-1',
      projectName: 'test-project',
      clusters: [],
      bySeverity: {},
      byKind: {},
      crossRun: undefined, // no crossRun = no regressed trigger
      actualRuntimeMs: 1000,
      dryRun: true,
    });

    expect(results).toHaveLength(0);
  });
});
