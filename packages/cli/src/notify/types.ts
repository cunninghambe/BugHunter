// v0.48: Notification types — ChannelTarget discriminated union + payload shapes.

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Trigger kinds
// ---------------------------------------------------------------------------

export type NotifyTrigger = 'critical' | 'regressed' | 'fixVerified' | 'summary';

// ---------------------------------------------------------------------------
// ChannelTarget discriminated union
// ---------------------------------------------------------------------------

const WebhookTargetSchema = z.object({
  kind: z.literal('webhook'),
  url: z.string().min(1),
  headers: z.record(z.string()).optional(),
  triggers: z.array(z.enum(['critical', 'regressed', 'fixVerified', 'summary'])).optional(),
});

const SlackWebhookTargetSchema = z.object({
  kind: z.literal('slack-webhook'),
  url: z.string().min(1),
  triggers: z.array(z.enum(['critical', 'regressed', 'fixVerified', 'summary'])).optional(),
});

const SlackChannelTargetSchema = z.object({
  kind: z.literal('slack-channel'),
  channel: z.string().min(1),
  /** Deferred env-check: SLACK_TOKEN is validated at send time, not config-load. */
  triggers: z.array(z.enum(['critical', 'regressed', 'fixVerified', 'summary'])).optional(),
});

const DiscordWebhookTargetSchema = z.object({
  kind: z.literal('discord-webhook'),
  url: z.string().min(1),
  triggers: z.array(z.enum(['critical', 'regressed', 'fixVerified', 'summary'])).optional(),
});

const EmailTargetSchema = z.object({
  kind: z.literal('email'),
  to: z.union([z.string().min(1), z.array(z.string().min(1))]),
  from: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  /** Deferred env-check: RESEND_API_KEY is validated at send time, not config-load. */
  triggers: z.array(z.enum(['critical', 'regressed', 'fixVerified', 'summary'])).optional(),
});

export const ChannelTargetSchema = z.discriminatedUnion('kind', [
  WebhookTargetSchema,
  SlackWebhookTargetSchema,
  SlackChannelTargetSchema,
  DiscordWebhookTargetSchema,
  EmailTargetSchema,
]);

export type ChannelTarget = z.infer<typeof ChannelTargetSchema>;

// ---------------------------------------------------------------------------
// Notifications config block
// ---------------------------------------------------------------------------

export const NotificationsConfigSchema = z.object({
  channels: z.array(ChannelTargetSchema).min(1),
  /** Default triggers when a channel omits its own triggers list. Defaults to ['summary']. */
  defaultTriggers: z.array(z.enum(['critical', 'regressed', 'fixVerified', 'summary'])).optional(),
  /** When true, a notification failure causes the run to exit with code 1. Default: false. */
  failOnNotifyError: z.boolean().optional(),
  /**
   * Allow requests to private/loopback addresses. Default: false (SSRF guard on).
   * Only set true in fully private network environments; never for production configs.
   */
  allowPrivateNetworks: z.boolean().optional(),
});

export type NotificationsConfig = z.infer<typeof NotificationsConfigSchema>;

// ---------------------------------------------------------------------------
// Notification payload (canonical JSON POST body for the webhook adapter)
// ---------------------------------------------------------------------------

export type BugSummary = {
  kind: string;
  rootCause: string;
  severity?: string;
  bugIdentity?: string;
};

/** Canonical notification payload sent by every channel adapter. */
export type NotifyPayload = {
  /** Always 'summary'. */
  trigger: NotifyTrigger;
  runId: string;
  projectName: string;
  bugsTotal: number;
  bySeverity: Record<string, number>;
  byKind: Record<string, number>;
  /** Always-present even when no cross-run data exists. */
  crossRun: {
    newBugs: number;
    regressed: number;
    goneSinceLast: number;
    persistent: number;
  } | null;
  /** Up to 25 bugs, ordered by severity desc. truncated=true when >25 exist. */
  criticalBugs: BugSummary[];
  truncated: boolean;
  actualRuntimeMs: number;
  summaryUrl?: string;
};

/** Result of a single send attempt. */
export type SendResult = {
  channelKind: string;
  trigger: NotifyTrigger;
  ok: boolean;
  durationMs: number;
  statusCode?: number;
  error?: string;
};
