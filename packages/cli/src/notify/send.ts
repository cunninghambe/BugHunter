// v0.48: Notification dispatcher — eval triggers, send concurrently, log failures.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as dns from 'node:dns/promises';
import { log } from '../log.js';
import type { NotificationsConfig, NotifyTrigger, ChannelTarget, NotifyPayload, SendResult } from './types.js';
import type { BugCluster, CrossRunSummary } from '../types.js';
import { sendWebhook } from './adapters/webhook.js';
import { sendSlackWebhook } from './adapters/slack-webhook.js';
import { sendSlackChannel } from './adapters/slack-channel.js';
import { sendDiscordWebhook } from './adapters/discord-webhook.js';
import { sendEmail } from './adapters/email.js';

const NOTIFY_BUDGET_MS = 15_000;
const PER_SEND_TIMEOUT_MS = 5_000;
const CLUSTER_CAP = 25;

// ---------------------------------------------------------------------------
// SSRF guard
// ---------------------------------------------------------------------------

const PRIVATE_RANGES = [
  /^127\./,
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^::1$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  /^169\.254\./,
  /^0\.0\.0\.0$/,
];

async function isPrivateAddress(host: string): Promise<boolean> {
  // Reject bare IP patterns first without DNS lookup
  if (PRIVATE_RANGES.some(r => r.test(host))) return true;
  try {
    const addrs = await dns.lookup(host, { all: true });
    return addrs.some(a => PRIVATE_RANGES.some(r => r.test(a.address)));
  } catch {
    // DNS failure — conservative: allow (network error surfaces at send time)
    return false;
  }
}

async function ssrfGuard(url: string, allow: boolean): Promise<void> {
  if (allow) return;
  const parsed = new URL(url);
  const host = parsed.hostname;
  if (await isPrivateAddress(host)) {
    throw new Error(`SSRF guard: ${host} resolves to a private address. Set allowPrivateNetworks: true to override.`);
  }
}

// ---------------------------------------------------------------------------
// Env-var interpolation: ${VAR_NAME}
// ---------------------------------------------------------------------------

export function interpolateEnv(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const v = process.env[name];
    if (v === undefined) {
      throw new Error(`Notification config references undefined env var: ${name}`);
    }
    return v;
  });
}

/** Interpolate env vars in URL and string-valued header fields. Throws on missing vars. */
export function interpolateChannel(channel: ChannelTarget): ChannelTarget {
  switch (channel.kind) {
    case 'webhook':
      return {
        ...channel,
        url: interpolateEnv(channel.url),
        headers: channel.headers !== undefined
          ? Object.fromEntries(Object.entries(channel.headers).map(([k, v]) => [k, interpolateEnv(v)]))
          : undefined,
      };
    case 'slack-webhook':
      return { ...channel, url: interpolateEnv(channel.url) };
    case 'discord-webhook':
      return { ...channel, url: interpolateEnv(channel.url) };
    case 'slack-channel':
      return { ...channel, channel: interpolateEnv(channel.channel) };
    case 'email': {
      const to = Array.isArray(channel.to)
        ? channel.to.map(interpolateEnv)
        : interpolateEnv(channel.to);
      return { ...channel, to };
    }
  }
}

// ---------------------------------------------------------------------------
// Payload builder
// ---------------------------------------------------------------------------

const SEVERITY_ORDER: Record<string, number> = { critical: 0, major: 1, minor: 2, info: 3 };

export function buildPayload(opts: {
  trigger: NotifyTrigger;
  runId: string;
  projectName: string;
  clusters: BugCluster[];
  bySeverity: Record<string, number>;
  byKind: Record<string, number>;
  crossRun: CrossRunSummary | undefined;
  actualRuntimeMs: number;
}): NotifyPayload {
  const sorted = [...opts.clusters].sort((a, b) => {
    const sa = SEVERITY_ORDER[a.severity ?? 'info'] ?? 3;
    const sb = SEVERITY_ORDER[b.severity ?? 'info'] ?? 3;
    return sa - sb;
  });

  const capped = sorted.slice(0, CLUSTER_CAP);
  const truncated = opts.clusters.length > CLUSTER_CAP;

  return {
    trigger: opts.trigger,
    runId: opts.runId,
    projectName: opts.projectName,
    bugsTotal: opts.clusters.length,
    bySeverity: opts.bySeverity,
    byKind: opts.byKind,
    crossRun: opts.crossRun !== undefined
      ? {
          newBugs: opts.crossRun.newBugs,
          regressed: opts.crossRun.regressed,
          goneSinceLast: opts.crossRun.goneSinceLast,
          persistent: opts.crossRun.persistent,
        }
      : null,
    criticalBugs: capped.map(c => ({
      kind: c.kind,
      rootCause: c.rootCause,
      severity: c.severity,
      bugIdentity: c.bugIdentity,
    })),
    truncated,
    actualRuntimeMs: opts.actualRuntimeMs,
  };
}

// ---------------------------------------------------------------------------
// Trigger evaluation
// ---------------------------------------------------------------------------

function resolveChannelTriggers(
  channel: ChannelTarget,
  defaultTriggers: NotifyTrigger[],
): NotifyTrigger[] {
  return channel.triggers ?? defaultTriggers;
}

function shouldFire(trigger: NotifyTrigger, activeTriggersForRun: Set<NotifyTrigger>): boolean {
  return activeTriggersForRun.has(trigger);
}

function computeActiveTriggersForRun(opts: {
  clusters: BugCluster[];
  crossRun: CrossRunSummary | undefined;
}): Set<NotifyTrigger> {
  const active = new Set<NotifyTrigger>(['summary'] as NotifyTrigger[]);

  const hasCritical = opts.clusters.some(c => c.severity === 'critical');
  if (hasCritical) active.add('critical');

  if (opts.crossRun !== undefined && opts.crossRun.regressed > 0) {
    active.add('regressed');
  }

  // fixVerified: any cluster with verdict verified_fixed in this run's crossRun
  // The spec says "fixVerified" fires when bugs that were verified_fixed in a prior
  // run do NOT reappear. We compute this from crossRun.goneSinceLast > 0.
  if (opts.crossRun !== undefined && opts.crossRun.goneSinceLast > 0) {
    active.add('fixVerified');
  }

  return active;
}

// ---------------------------------------------------------------------------
// Per-channel send dispatch
// ---------------------------------------------------------------------------

async function dispatchOne(
  channel: ChannelTarget,
  payload: NotifyPayload,
  trigger: NotifyTrigger,
  allow: boolean,
): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const perSendAbort = new AbortController();
  const timer = setTimeout(() => perSendAbort.abort(), PER_SEND_TIMEOUT_MS);
  const signal = perSendAbort.signal;

  try {
    switch (channel.kind) {
      case 'webhook':
        await ssrfGuard(channel.url, allow);
        return await sendWebhook(channel.url, channel.headers, payload, signal);

      case 'slack-webhook':
        await ssrfGuard(channel.url, allow);
        return await sendSlackWebhook(channel.url, payload, signal);

      case 'discord-webhook':
        await ssrfGuard(channel.url, allow);
        return await sendDiscordWebhook(channel.url, payload, signal);

      case 'slack-channel':
        // No URL to check — hits slack.com (public)
        return await sendSlackChannel(channel.channel, payload, signal);

      case 'email':
        // Resend API — hits api.resend.com (public)
        return await sendEmail(channel.to, channel.from, channel.subject, payload, signal);

      default: {
        const _exhaustive: never = channel;
        return { ok: false, error: `Unknown channel kind: ${(_exhaustive as ChannelTarget).kind}` };
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Failure log
// ---------------------------------------------------------------------------

function appendNotifyLog(logPath: string, result: SendResult & { trigger: NotifyTrigger }): void {
  // Never log full URLs (secret-bearing). Log channel kind + error only.
  const record = {
    ts: new Date().toISOString(),
    channelKind: result.channelKind,
    trigger: result.trigger,
    ok: result.ok,
    durationMs: result.durationMs,
    ...(result.statusCode !== undefined ? { statusCode: result.statusCode } : {}),
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
  try {
    fs.appendFileSync(logPath, `${JSON.stringify(record)}\n`);
  } catch {
    // Non-fatal: if we can't write the log, don't propagate
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function fireNotifications(opts: {
  config: NotificationsConfig;
  projectDir: string;
  runId: string;
  projectName: string;
  clusters: BugCluster[];
  bySeverity: Record<string, number>;
  byKind: Record<string, number>;
  crossRun: CrossRunSummary | undefined;
  actualRuntimeMs: number;
  dryRun?: boolean;
}): Promise<SendResult[]> {
  const {
    config,
    projectDir,
    clusters,
    crossRun,
    dryRun = false,
  } = opts;

  const allowPrivate = config.allowPrivateNetworks ?? false;
  const defaultTriggers: NotifyTrigger[] = config.defaultTriggers ?? ['summary'];
  const activeTriggersForRun = computeActiveTriggersForRun({ clusters, crossRun });

  // Interpolate env vars at send time (loud failure for non-secret channels was already
  // done at config-load; secret-bearing channels defer to here)
  let channels: ChannelTarget[];
  try {
    channels = config.channels.map(interpolateChannel);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('notify: env-var interpolation failed; skipping all notifications', { error: msg });
    return [];
  }

  // Build the (channel, trigger) pairs that should fire
  type SendJob = { channel: ChannelTarget; trigger: NotifyTrigger };
  const jobs: SendJob[] = [];

  for (const channel of channels) {
    const channelTriggers = resolveChannelTriggers(channel, defaultTriggers);
    for (const trigger of channelTriggers) {
      if (shouldFire(trigger, activeTriggersForRun)) {
        jobs.push({ channel, trigger });
      }
    }
  }

  if (jobs.length === 0) return [];

  if (dryRun) {
    log.info('notify-test: dry-run, would send', { jobs: jobs.map(j => ({ kind: j.channel.kind, trigger: j.trigger })) });
    return jobs.map(j => ({
      channelKind: j.channel.kind,
      trigger: j.trigger,
      ok: true,
      durationMs: 0,
    }));
  }

  // Shared 15s budget abort controller
  const budgetAbort = new AbortController();
  const budgetTimer = setTimeout(() => budgetAbort.abort(), NOTIFY_BUDGET_MS);

  const results: SendResult[] = await Promise.all(
    jobs.map(async ({ channel, trigger }): Promise<SendResult> => {
      const payload = buildPayload({
        trigger,
        runId: opts.runId,
        projectName: opts.projectName,
        clusters,
        bySeverity: opts.bySeverity,
        byKind: opts.byKind,
        crossRun,
        actualRuntimeMs: opts.actualRuntimeMs,
      });

      const t0 = Date.now();
      const res = await dispatchOne(channel, payload, trigger, allowPrivate);
      const durationMs = Date.now() - t0;

      const result: SendResult = {
        channelKind: channel.kind,
        trigger,
        ok: res.ok,
        durationMs,
        ...(res.statusCode !== undefined ? { statusCode: res.statusCode } : {}),
        ...(res.error !== undefined ? { error: res.error } : {}),
      };

      const notifyLog = path.join(projectDir, '.bughunter', 'runs', opts.runId, 'notifications.jsonl');
      if (!res.ok) {
        log.warn('notify: send failed', { channelKind: channel.kind, trigger, error: res.error });
        appendNotifyLog(notifyLog, { ...result, trigger });
      } else {
        log.info('notify: sent', { channelKind: channel.kind, trigger, durationMs });
        appendNotifyLog(notifyLog, { ...result, trigger });
      }

      return result;
    }),
  );

  clearTimeout(budgetTimer);
  return results;
}
