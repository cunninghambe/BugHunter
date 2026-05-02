// v0.48: Slack chat.postMessage adapter — requires SLACK_TOKEN env var.

import type { NotifyPayload } from '../types.js';

const SLACK_API_URL = 'https://slack.com/api/chat.postMessage';

function buildText(payload: NotifyPayload): string {
  const severityParts = Object.entries(payload.bySeverity)
    .filter(([, count]) => count > 0)
    .map(([sev, count]) => `${count} ${sev}`)
    .join(', ');

  const lines = [
    `*BugHunter run ${payload.runId}* — ${payload.projectName}`,
    `${payload.bugsTotal} bug(s) found${severityParts.length > 0 ? ` (${severityParts})` : ''}`,
  ];

  if (payload.crossRun !== null) {
    const { newBugs, regressed, goneSinceLast } = payload.crossRun;
    lines.push(`+${newBugs} new, ${regressed} regressed, ${goneSinceLast} gone`);
  }

  if (payload.truncated) {
    lines.push(`_(showing 25 of ${payload.bugsTotal} bugs)_`);
  }

  return lines.join('\n');
}

export async function sendSlackChannel(
  channel: string,
  payload: NotifyPayload,
  signal: AbortSignal,
): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const token = process.env['SLACK_TOKEN'];
  if (token === undefined || token === '') {
    return { ok: false, error: 'SLACK_TOKEN env var is required for slack-channel adapter' };
  }

  const body = { channel, text: buildText(payload) };
  const res = await fetch(SLACK_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  const json = await res.json().catch(() => ({})) as Record<string, unknown>;
  if (!res.ok || json['ok'] !== true) {
    const slackError = typeof json['error'] === 'string' ? json['error'] : String(res.status);
    return { ok: false, statusCode: res.status, error: slackError.slice(0, 200) };
  }
  return { ok: true, statusCode: res.status };
}
