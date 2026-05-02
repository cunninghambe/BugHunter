// Currency format variant — checks decimal-place rules for JPY, BHD, USD (§3.6).

import type { BrowserMcpAdapter } from '../../adapters/browser-mcp.js';
import type { BugDetection } from '../../types.js';
import { RESTORE_SCRIPT } from './variant-util.js';

type CurrencyCase = { currency: 'JPY' | 'BHD' | 'USD'; value: string; expectedDecimals: number };
const CASES: CurrencyCase[] = [
  { currency: 'JPY', value: '100', expectedDecimals: 0 },
  { currency: 'BHD', value: '100.123', expectedDecimals: 3 },
  { currency: 'USD', value: '100', expectedDecimals: 2 },
];

// Heuristic: find currency symbols / codes in rendered text
const CURRENCY_RE = /[$€¥£]\s?\d[\d,.]*/g;
const CURRENCY_CODE_RE = /\b(USD|EUR|JPY|BHD|JOD|KWD|CHF|GBP)\s?([\d,]+(?:\.\d+)?)/g;

function countDecimals(numStr: string): number {
  const dotIdx = numStr.lastIndexOf('.');
  if (dotIdx === -1) return 0;
  return numStr.length - dotIdx - 1;
}

function extractDecimalCount(text: string): number | undefined {
  const match = /[\d,]+(\.\d+)?/.exec(text.replace(/[^\d.,]/g, ''));
  if (match === null) return undefined;
  return countDecimals(match[0]);
}

function checkBodyText(
  bodyText: string,
  cc: CurrencyCase,
  pageUrl: string,
): BugDetection | undefined {
  const combined = [
    ...(bodyText.match(CURRENCY_RE) ?? []),
    ...(bodyText.match(CURRENCY_CODE_RE) ?? []),
  ];
  for (const raw of combined) {
    const decimals = extractDecimalCount(raw);
    if (decimals === undefined) continue;
    if (decimals !== cc.expectedDecimals) {
      return {
        kind: 'i18n_currency_format_broken',
        rootCause: `Currency ${cc.currency}: rendered with ${decimals} decimal(s) but expected ${cc.expectedDecimals} (value: ${cc.value})`,
        pageRoute: pageUrl,
        evidence: {
          currency: cc.currency,
          injectedValue: cc.value,
          expectedDecimals: cc.expectedDecimals,
          observedDecimals: decimals,
          renderedText: raw.slice(0, 40),
        },
      };
    }
  }
  return undefined;
}

const APPLY_TEMPLATE = (value: string) => `(() => {
  document.querySelectorAll('input[type=number], input[type=text][name*="amount"], input[type=text][name*="price"]').forEach(el => {
    el.setAttribute('data-bughunter-locale-prev-value', el.value || '');
    el.value = '${value}';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  return document.body.innerText;
})()`;

export async function runCurrencyVariant(
  browser: BrowserMcpAdapter,
  settleMs: number,
  pageUrl: string,
): Promise<{ detections: BugDetection[]; restored: boolean }> {
  const detections: BugDetection[] = [];

  for (const cc of CASES) {
    const result = await browser.evaluate(APPLY_TEMPLATE(cc.value)).catch(() => null);
    await new Promise<void>(r => { setTimeout(r, settleMs); });
    if (result !== null && typeof result.value === 'string') {
      const det = checkBodyText(result.value, cc, pageUrl);
      if (det !== undefined) detections.push(det);
    }
    // Restore between each case
    await browser.evaluate(RESTORE_SCRIPT).catch(() => {});
  }

  let restored = true;
  try {
    await browser.evaluate(RESTORE_SCRIPT);
  } catch {
    restored = false;
  }
  return { detections, restored };
}
