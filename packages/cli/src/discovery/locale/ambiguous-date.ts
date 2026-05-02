// Ambiguous-date locale variant — injects 2026-03-04 and checks rendered format (§3.3).

import type { BrowserMcpAdapter } from '../../adapters/browser-mcp.js';
import type { BugDetection } from '../../types.js';
import { RESTORE_SCRIPT } from './variant-util.js';

const AMBIGUOUS_DATE = '2026-03-04';

const BAD_DATE_RE = /\b(0?[1-9]|1[0-2])\/(0?[1-9]|[12]\d|3[01])\/\d{4}\b/;
const GOOD_DATE_RES = [
  /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i,
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}\.\d{1,2}\.\d{4}\b/,
];

const APPLY_SCRIPT = `(() => {
  const dateVal = '${AMBIGUOUS_DATE}';
  document.querySelectorAll('input[type=date]').forEach(el => {
    el.setAttribute('data-bughunter-locale-prev-value', el.value || '');
    el.value = dateVal;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return document.body.innerText;
})()`;

function hasAmbiguousDate(text: string): boolean {
  if (!BAD_DATE_RE.test(text)) return false;
  return !GOOD_DATE_RES.some(re => re.test(text));
}

export async function runAmbiguousDateVariant(
  browser: BrowserMcpAdapter,
  settleMs: number,
  pageUrl: string,
): Promise<{ detections: BugDetection[]; restored: boolean }> {
  const result = await browser.evaluate(APPLY_SCRIPT).catch(() => null);
  await new Promise<void>(r => { setTimeout(r, settleMs); });

  const detections: BugDetection[] = [];
  if (result !== null && typeof result.value === 'string' && hasAmbiguousDate(result.value)) {
    detections.push({
      kind: 'i18n_date_format_ambiguous',
      rootCause: `Date value ${AMBIGUOUS_DATE} rendered in ambiguous MM/DD/YYYY or DD/MM/YYYY format without month name or ISO 8601`,
      pageRoute: pageUrl,
      evidence: { injectedDate: AMBIGUOUS_DATE, detectedPattern: BAD_DATE_RE.source },
    });
  }

  let restored = true;
  try {
    await browser.evaluate(RESTORE_SCRIPT);
  } catch {
    restored = false;
  }
  return { detections, restored };
}
