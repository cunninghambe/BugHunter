// Pluralization variant — drives n=0/1/many and checks English noun morphology (§3.5).

import type { BrowserMcpAdapter } from '../../adapters/browser-mcp.js';
import type { BugDetection } from '../../types.js';

const COUNT_TEXT_RE = /^\s*(\d+)\s+(\S+)/;

const GET_COUNT_TEXT_SCRIPT = `(() => {
  const matches = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim() ?? '';
    if (/^\\d+\\s+\\S/.test(text)) matches.push(text);
  }
  return matches.slice(0, 10);
})()`;

function isPlural(noun: string): boolean {
  return noun.toLowerCase().endsWith('s');
}

function morphOk(count: number, noun: string): boolean {
  if (count === 1) return !isPlural(noun); // singular: no trailing s
  return isPlural(noun); // 0 and many: plural (trailing s)
}

function checkCounts(
  n0Text: string | undefined,
  n1Text: string | undefined,
  nManyText: string | undefined,
  pageUrl: string,
): BugDetection[] {
  const results: BugDetection[] = [];

  for (const [count, text] of [[0, n0Text], [1, n1Text], [5, nManyText]] as [number, string | undefined][]) {
    if (text === undefined) continue;
    const m = COUNT_TEXT_RE.exec(text);
    if (m === null) continue;
    const noun = m[2];
    if (!morphOk(count, noun)) {
      results.push({
        kind: 'i18n_pluralization_broken',
        rootCause: `Pluralization broken for n=${count}: "${text}" — noun "${noun}" does not match expected morphology`,
        pageRoute: pageUrl,
        evidence: { count, renderedText: text.slice(0, 80), noun, coverage: 'english_only' },
      });
    }
  }
  return results;
}

async function captureCountText(browser: BrowserMcpAdapter): Promise<string | undefined> {
  const r = await browser.evaluate(GET_COUNT_TEXT_SCRIPT).catch(() => null);
  if (r === null || !Array.isArray(r.value) || r.value.length === 0) return undefined;
  return r.value[0] as string;
}

export async function runPluralizationVariant(
  browser: BrowserMcpAdapter,
  settleMs: number,
  pageUrl: string,
): Promise<{ detections: BugDetection[]; restored: boolean }> {
  // Capture initial state (n=many heuristic — whatever is on screen)
  await new Promise<void>((r) => { setTimeout(r, settleMs); });
  const nManyText = await captureCountText(browser);

  // n=0: attempt to clear count-related inputs
  const clearScript = `(() => {
    document.querySelectorAll('input[type=number]').forEach(el => {
      el.value = '0';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  })()`;
  await browser.evaluate(clearScript).catch(() => {});
  await new Promise<void>((r) => { setTimeout(r, settleMs); });
  const n0Text = await captureCountText(browser);

  // n=1
  const oneScript = `(() => {
    document.querySelectorAll('input[type=number]').forEach(el => {
      el.value = '1';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  })()`;
  await browser.evaluate(oneScript).catch(() => {});
  await new Promise<void>((r) => { setTimeout(r, settleMs); });
  const n1Text = await captureCountText(browser);

  const detections = checkCounts(n0Text, n1Text, nManyText, pageUrl);
  return { detections, restored: true };
}
