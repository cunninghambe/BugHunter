// Timezone display checker — detects timestamps without any timezone indicator (§3.7).

import type { BrowserMcpAdapter } from '../../adapters/browser-mcp.js';
import type { BugDetection } from '../../types.js';

const TIME_RE = /\b\d{1,2}:\d{2}(:\d{2})?\b/g;
const TZ_DISAMBIGUATORS = [
  /\bAM\b/i, /\bPM\b/i, /\bUTC\b/, /\bGMT\b/, /\bZ\b/,
  /[+-]\d{2}:\d{2}/, /\b[A-Z]{2,4}T\b/, // EST, JST, IST, ...
];

const GET_BODY_TEXT_SCRIPT = `(() => document.body.innerText)()`;

function windowAround(text: string, index: number, radius: number): string {
  return text.slice(Math.max(0, index - radius), Math.min(text.length, index + radius));
}

function hasTzDisambiguator(window: string): boolean {
  return TZ_DISAMBIGUATORS.some(re => re.test(window));
}

export async function runTimezoneDisplayVariant(
  browser: BrowserMcpAdapter,
  settleMs: number,
  pageUrl: string,
): Promise<{ detections: BugDetection[]; restored: boolean }> {
  await new Promise(r => setTimeout(r, settleMs));
  const result = await browser.evaluate(GET_BODY_TEXT_SCRIPT).catch(() => null);
  if (result === null || typeof result.value !== 'string') return { detections: [], restored: true };

  const bodyText = result.value;
  const detections: BugDetection[] = [];
  const seenWindows = new Set<string>();

  let m: RegExpExecArray | null;
  TIME_RE.lastIndex = 0;
  while ((m = TIME_RE.exec(bodyText)) !== null) {
    const surrounding = windowAround(bodyText, m.index, 40);
    if (seenWindows.has(surrounding)) continue;
    seenWindows.add(surrounding);

    if (!hasTzDisambiguator(surrounding)) {
      const clusterKey = `${pageUrl}:${surrounding.trim().slice(0, 40)}`;
      detections.push({
        kind: 'i18n_timezone_display_wrong',
        rootCause: `Timestamp "${m[0]}" displayed without timezone indicator`,
        pageRoute: pageUrl,
        evidence: {
          subClass: 'no_tz_indicator',
          timestamp: m[0],
          surroundingText: surrounding.trim().slice(0, 80),
          clusterKey,
        },
      });
    }
  }

  return { detections, restored: true };
}
