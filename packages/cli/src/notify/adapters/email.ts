// v0.48: Email adapter — Resend API (https://resend.com).

import type { NotifyPayload } from '../types.js';

const RESEND_API_URL = 'https://api.resend.com/emails';
const DEFAULT_FROM = 'BugHunter <notifications@bughunter.dev>';

function buildHtml(payload: NotifyPayload): string {
  const rows = payload.criticalBugs.map(b =>
    `<tr><td>${b.kind}</td><td>${b.severity ?? ''}</td><td>${b.rootCause.slice(0, 120)}</td></tr>`,
  ).join('');

  const tableSection = payload.criticalBugs.length > 0
    ? `<table border="1" cellpadding="4"><thead><tr><th>Kind</th><th>Severity</th><th>Root cause</th></tr></thead><tbody>${rows}</tbody></table>`
    : '';

  const crossRunSection = payload.crossRun !== null
    ? `<p>Cross-run: +${payload.crossRun.newBugs} new · ${payload.crossRun.regressed} regressed · ${payload.crossRun.goneSinceLast} gone</p>`
    : '';

  return [
    `<h2>BugHunter run ${payload.runId} — ${payload.projectName}</h2>`,
    `<p>${payload.bugsTotal} bug(s) found · runtime ${Math.round(payload.actualRuntimeMs / 1000)}s</p>`,
    crossRunSection,
    tableSection,
    payload.truncated ? `<p><em>Showing 25 of ${payload.bugsTotal} bugs</em></p>` : '',
  ].filter(Boolean).join('\n');
}

export async function sendEmail(
  to: string | string[],
  from: string | undefined,
  subject: string | undefined,
  payload: NotifyPayload,
  signal: AbortSignal,
): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const apiKey = process.env['RESEND_API_KEY'];
  if (apiKey === undefined || apiKey === '') {
    return { ok: false, error: 'RESEND_API_KEY env var is required for email adapter' };
  }

  const resolvedSubject = subject ?? `BugHunter: ${payload.bugsTotal} bug(s) — ${payload.projectName} run ${payload.runId}`;

  const body = {
    from: from ?? DEFAULT_FROM,
    to: Array.isArray(to) ? to : [to],
    subject: resolvedSubject,
    html: buildHtml(payload),
  };

  const res = await fetch(RESEND_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, statusCode: res.status, error: text.slice(0, 200) };
  }
  return { ok: true, statusCode: res.status };
}
