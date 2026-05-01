// v0.48: Discord webhook adapter.

import type { NotifyPayload } from '../types.js';

function buildContent(payload: NotifyPayload): string {
  const severityParts = Object.entries(payload.bySeverity)
    .filter(([, count]) => count > 0)
    .map(([sev, count]) => `${count} ${sev}`)
    .join(', ');

  const lines = [
    `**BugHunter run \`${payload.runId}\`** — ${payload.projectName}`,
    `${payload.bugsTotal} bug(s) found${severityParts.length > 0 ? ` (${severityParts})` : ''}`,
  ];

  if (payload.crossRun !== null) {
    const { newBugs, regressed, goneSinceLast } = payload.crossRun;
    lines.push(`+${newBugs} new · ${regressed} regressed · ${goneSinceLast} gone`);
  }

  if (payload.truncated) {
    lines.push(`_Showing 25 of ${payload.bugsTotal} bugs_`);
  }

  return lines.join('\n');
}

export async function sendDiscordWebhook(
  url: string,
  payload: NotifyPayload,
  signal: AbortSignal,
): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const body = { content: buildContent(payload) };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });

  // Discord 204 = No Content on success, 200 = returns message object
  if (res.status === 204 || res.ok) {
    return { ok: true, statusCode: res.status };
  }
  const text = await res.text().catch(() => '');
  return { ok: false, statusCode: res.status, error: text.slice(0, 200) };
}
