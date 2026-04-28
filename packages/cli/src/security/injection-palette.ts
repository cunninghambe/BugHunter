// Pure canary-payload generation for XSS detection (v0.7).
// No IO — unit-testable, nonces are cryptographically random.

import * as crypto from 'node:crypto';

export type InjectionContext = 'html_body' | 'html_attr' | 'js_string' | 'url_param' | 'json_body';

export type CanaryPayload = {
  /** The literal value to inject. */
  value: string;
  /** 16-char hex nonce embedded in the value. Used for detection. */
  nonce: string;
  /** Which sink shape this payload tests. */
  context: InjectionContext;
  /** Human-readable name for rootCause string. */
  variant: string;
};

function freshNonce(): string {
  return crypto.randomBytes(8).toString('hex');
}

function minimal(nonce: string): CanaryPayload[] {
  return [
    {
      variant: 'script_tag_basic',
      context: 'html_body',
      nonce,
      value: `<script>window.__bh_xss_${nonce}=1</script>`,
    },
    {
      variant: 'img_onerror',
      context: 'html_body',
      nonce,
      value: `<img src=x onerror="window.__bh_xss_${nonce}=1">`,
    },
    {
      variant: 'attribute_breakout',
      context: 'html_attr',
      nonce,
      value: `" autofocus onfocus="window.__bh_xss_${nonce}=1`,
    },
    {
      variant: 'url_javascript',
      context: 'url_param',
      nonce,
      value: `javascript:window.__bh_xss_${nonce}=1`,
    },
    {
      variant: 'string_breakout',
      context: 'js_string',
      nonce,
      value: `';window.__bh_xss_${nonce}=1;//`,
    },
  ];
}

function extraFull(nonce: string): CanaryPayload[] {
  return [
    {
      variant: 'svg_onload',
      context: 'html_body',
      nonce,
      value: `<svg onload="window.__bh_xss_${nonce}=1">`,
    },
    {
      variant: 'iframe_srcdoc',
      context: 'html_body',
      nonce,
      value: `<iframe srcdoc="<script>window.__bh_xss_${nonce}=1</script>">`,
    },
    {
      variant: 'details_ontoggle',
      context: 'html_body',
      nonce,
      value: `<details open ontoggle="window.__bh_xss_${nonce}=1">`,
    },
    {
      variant: 'style_expression',
      context: 'html_attr',
      nonce,
      value: `" style="xss:expression(window.__bh_xss_${nonce}=1)`,
    },
    {
      variant: 'meta_refresh',
      context: 'html_body',
      nonce,
      value: `<meta http-equiv="refresh" content="0;url=javascript:window.__bh_xss_${nonce}=1">`,
    },
    {
      variant: 'data_uri_html',
      context: 'url_param',
      nonce,
      value: `data:text/html,<script>window.__bh_xss_${nonce}=1</script>`,
    },
    {
      variant: 'template_literal_breakout',
      context: 'js_string',
      nonce,
      value: `\`+window.__bh_xss_${nonce}=1+\``,
    },
  ];
}

/**
 * Generate canary payloads. Each call produces fresh nonces, so two calls
 * never collide even for the same variant.
 */
export function generateCanaries(count: 'minimal' | 'full'): CanaryPayload[] {
  const nonce = freshNonce();
  const base = minimal(nonce);
  if (count === 'minimal') return base;
  return [...base, ...extraFull(freshNonce())];
}

export function buildCanaryRegex(nonce: string): RegExp {
  return new RegExp(`__bh_xss_${nonce}`, 'i');
}

/**
 * Returns true iff a tag containing the nonce is present in the body unescaped.
 * This covers:
 *   - Nonce inside a tag's opening attributes (e.g. <img onerror="...nonce...">)
 *   - Nonce inside executable element content (e.g. <script>...nonce...</script>)
 * HTML-encoded occurrences (e.g. &lt;script&gt;...nonce...) do not count.
 */
export function canaryAppearsAsHtml(body: string, nonce: string): boolean {
  // Case 1: nonce appears inside a real tag's opening attributes
  const tagAttrRegex = new RegExp(`<[a-z][^>]*__bh_xss_${nonce}`, 'i');
  if (tagAttrRegex.test(body)) return true;
  // Case 2: nonce appears inside an executable element block (<script>, <svg>, etc.)
  // Strip HTML-encoded tags first so encoded representations don't match as real elements.
  const stripped = body.replace(/&lt;/gi, '\x00lt\x00').replace(/&gt;/gi, '\x00gt\x00');
  const execBlockRegex = new RegExp(
    `<(script|svg|iframe|object|embed)[^>]*>[\\s\\S]*?__bh_xss_${nonce}`,
    'i',
  );
  return execBlockRegex.test(stripped);
}

/**
 * Returns true iff the nonce appears inside an event-handler attribute or style expression.
 */
export function canaryAppearsAsAttribute(body: string, nonce: string): boolean {
  const onEventRegex = new RegExp(`<[^>]*\\son[a-z]+\\s*=\\s*["']?[^"'>]*__bh_xss_${nonce}`, 'i');
  if (onEventRegex.test(body)) return true;
  const styleExprRegex = new RegExp(`style\\s*=\\s*["'][^"']*expression\\([^)]*__bh_xss_${nonce}`, 'i');
  return styleExprRegex.test(body);
}

/**
 * Returns true iff the nonce appears inside a <script>…</script> block.
 */
export function canaryAppearsInScriptTag(body: string, nonce: string): boolean {
  const scriptBlocks = body.match(/<script[^>]*>([\s\S]*?)<\/script>/gi);
  if (scriptBlocks === null) return false;
  return scriptBlocks.some(block => block.includes(`__bh_xss_${nonce}`));
}
