// v0.48: Generic webhook adapter — canonical JSON POST.

import type { NotifyPayload } from '../types.js';

export async function sendWebhook(
  url: string,
  headers: Record<string, string> | undefined,
  payload: NotifyPayload,
  signal: AbortSignal,
): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    body: JSON.stringify(payload),
    signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, statusCode: res.status, error: body.slice(0, 200) };
  }
  return { ok: true, statusCode: res.status };
}
