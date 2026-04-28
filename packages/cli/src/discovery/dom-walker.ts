// DOM walker — visits pages via browser MCP and extracts interactive elements (§ 3.3).

import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import type { Element, DiscoveredForm, FormField } from '../types.js';
import { log } from '../log.js';

export type DomWalkResult = {
  elements: Element[];
  forms: DiscoveredForm[];
  links: string[];
};

// Script injected into the page to collect all interactive elements.
const COLLECT_ELEMENTS_SCRIPT = `
(function() {
  function ancestorStack(el, depth) {
    const parts = [];
    let cur = el.parentElement;
    for (let i = 0; i < depth && cur; i++, cur = cur.parentElement) {
      parts.push(cur.tagName.toLowerCase() + (cur.id ? '#' + cur.id : '') + (cur.className ? '.' + cur.className.split(' ')[0] : ''));
    }
    return parts.join('>');
  }

  function bestSelector(el) {
    if (el.id) return '#' + el.id;
    const testId = el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + testId + '"]';
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel) return el.tagName.toLowerCase() + '[aria-label="' + ariaLabel + '"]';
    return el.tagName.toLowerCase() + ':nth-of-type(' + (Array.from(el.parentElement?.children ?? []).indexOf(el) + 1) + ')';
  }

  const selectors = ['button', 'a[href]', 'input', 'select', 'textarea', '[role="button"]', '[role="link"]', '[onclick]', '[contenteditable]'];
  const els = [];
  for (const sel of selectors) {
    document.querySelectorAll(sel).forEach(el => {
      els.push({
        tag: el.tagName.toLowerCase(),
        roleAttr: el.getAttribute('role') || undefined,
        typeAttr: el.getAttribute('type') || undefined,
        testId: el.getAttribute('data-testid') || undefined,
        ancestorStack: ancestorStack(el, 3),
        selector: bestSelector(el),
        disabled: el.disabled || el.getAttribute('aria-disabled') === 'true',
        href: el.getAttribute('href') || undefined,
        text: (el.textContent || '').trim().slice(0, 80),
      });
    });
  }

  // Forms
  const forms = [];
  document.querySelectorAll('form').forEach((form, i) => {
    const fields = [];
    form.querySelectorAll('input, select, textarea').forEach(input => {
      const name = input.getAttribute('name') || input.getAttribute('id') || 'field_' + fields.length;
      const type = input.getAttribute('type') || (input.tagName === 'SELECT' ? 'select' : input.tagName === 'TEXTAREA' ? 'text' : 'text');
      const options = input.tagName === 'SELECT' ? Array.from(input.options).map(o => o.value) : undefined;
      fields.push({
        name,
        type,
        required: input.required || input.getAttribute('aria-required') === 'true',
        options,
      });
    });
    forms.push({
      formSelector: form.id ? '#' + form.id : 'form:nth-of-type(' + (i + 1) + ')',
      fields,
      action: form.getAttribute('action') || undefined,
      method: (form.getAttribute('method') || 'GET').toUpperCase(),
    });
  });

  // Links
  const links = Array.from(document.querySelectorAll('a[href]'))
    .map(a => a.getAttribute('href'))
    .filter(h => h && !h.startsWith('#') && !h.startsWith('javascript:'));

  return { elements: els, forms, links };
})()
`;

type RawEvalResult = {
  elements: Array<{
    tag: string;
    roleAttr?: string;
    typeAttr?: string;
    testId?: string;
    ancestorStack: string;
    selector: string;
    disabled: boolean;
    href?: string;
    text?: string;
  }>;
  forms: Array<{
    formSelector: string;
    fields: Array<{ name: string; type: string; required: boolean; options?: string[] }>;
    action?: string;
    method: string;
  }>;
  links: string[];
};

function shapeFromEvalResult(evalResult: { value: unknown }): DomWalkResult {
  const raw = evalResult.value as RawEvalResult;

  const elements: Element[] = raw.elements.map(e => ({
    tag: e.tag,
    roleAttr: e.roleAttr,
    typeAttr: e.typeAttr,
    testId: e.testId,
    ancestorStack: e.ancestorStack,
    selector: e.selector,
    disabled: e.disabled,
    href: e.href,
    text: e.text,
  }));

  const forms: DiscoveredForm[] = raw.forms.map(f => ({
    formSelector: f.formSelector,
    fields: f.fields.map(field => ({
      name: field.name,
      type: normalizeInputType(field.type),
      required: field.required,
      options: field.options,
    })),
    action: f.action,
    method: f.method,
  }));

  return { elements, forms, links: raw.links };
}

/** Snapshot the current page DOM without navigating. Safe to call after a click/state-change. */
export async function collectDomOnly(browser: BrowserMcpAdapter): Promise<DomWalkResult> {
  await browser.scroll('body', 'down', 1500).catch(() => {});
  const evalResult = await browser.evaluate(COLLECT_ELEMENTS_SCRIPT).catch((err: unknown) => {
    log.warn('DOM collectDomOnly evaluate failed', err);
    return null;
  });
  if (!evalResult) return { elements: [], forms: [], links: [] };
  return shapeFromEvalResult(evalResult);
}

export async function walkDom(
  browser: BrowserMcpAdapter,
  url: string,
  runId: string,
  extraHeaders?: Record<string, string>
): Promise<DomWalkResult> {
  const headers = { 'X-BugHunter-Run': runId, ...(extraHeaders ?? {}) };
  await browser.navigate(url, headers);
  // Scroll to trigger lazy-loads
  await browser.scroll('body', 'down', 3000).catch(() => {});
  await browser.scroll('body', 'down', 3000).catch(() => {});
  const evalResult = await browser.evaluate(COLLECT_ELEMENTS_SCRIPT).catch((err: unknown) => {
    log.warn('DOM walk evaluate failed', err);
    return null;
  });
  if (!evalResult) return { elements: [], forms: [], links: [] };
  return shapeFromEvalResult(evalResult);
}

function normalizeInputType(t: string): FormField['type'] {
  const map: Record<string, FormField['type']> = {
    text: 'text', email: 'email', number: 'number', date: 'date',
    checkbox: 'checkbox', file: 'file', password: 'password',
    tel: 'tel', url: 'url', color: 'color', range: 'range',
    select: 'select', textarea: 'text',
  };
  return map[t.toLowerCase()] ?? 'text';
}
