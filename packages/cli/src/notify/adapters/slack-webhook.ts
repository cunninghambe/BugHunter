// v0.48: Slack incoming-webhook adapter.

import type { NotifyPayload } from '../types.js';

function buildSlackText(payload: NotifyPayload): string {
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

export async function sendSlackWebhook(
  url: string,
  payload: NotifyPayload,
  signal: AbortSignal,
): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const body = { text: buildSlackText(payload) };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, statusCode: res.status, error: text.slice(0, 200) };
  }
  return { ok: true, statusCode: res.status };
}
