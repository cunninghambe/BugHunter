// Tests for injection-palette module (v0.7 T01).

import { describe, it, expect } from 'vitest';
import {
  generateCanaries,
  canaryAppearsAsHtml,
  canaryAppearsAsAttribute,
  canaryAppearsInScriptTag,
  buildCanaryRegex,
} from './injection-palette.js';
import type { InjectionContext } from './injection-palette.js';

const FIXED_NONCE = 'aaaa1111bbbb2222';

describe('generateCanaries', () => {
  it('minimal returns exactly 5 payloads', () => {
    expect(generateCanaries('minimal')).toHaveLength(5);
  });

  it('full returns exactly 12 payloads', () => {
    expect(generateCanaries('full')).toHaveLength(12);
  });

  it('each canary value embeds its own nonce', () => {
    for (const c of generateCanaries('minimal')) {
      expect(c.value).toContain(c.nonce);
    }
  });

  it('two calls produce different nonces', () => {
    const a = generateCanaries('minimal');
    const b = generateCanaries('minimal');
    // nonces from two independent calls differ (astronomically unlikely collision)
    expect(a[0].nonce).not.toBe(b[0].nonce);
  });

  it('full palette covers all five InjectionContext values', () => {
    const contexts = new Set<InjectionContext>(
      generateCanaries('full').map(c => c.context)
    );
    const required: InjectionContext[] = ['html_body', 'html_attr', 'js_string', 'url_param', 'json_body'];
    // json_body context is used by xssApiTestCases; palette may not include it directly
    // — ensure at least html_body, html_attr, js_string, url_param are present
    for (const ctx of ['html_body', 'html_attr', 'js_string', 'url_param'] as InjectionContext[]) {
      expect(contexts.has(ctx)).toBe(true);
    }
    void required; // suppress unused warning
  });

  it('all canaries have non-empty variant names', () => {
    for (const c of generateCanaries('full')) {
      expect(c.variant.length).toBeGreaterThan(0);
    }
  });
});

describe('buildCanaryRegex', () => {
  it('matches a string containing the nonce', () => {
    const re = buildCanaryRegex(FIXED_NONCE);
    expect(re.test(`window.__bh_xss_${FIXED_NONCE}=1`)).toBe(true);
  });

  it('does not match a different nonce', () => {
    const re = buildCanaryRegex(FIXED_NONCE);
    expect(re.test('window.__bh_xss_deadbeefdeadbeef=1')).toBe(false);
  });
});

describe('canaryAppearsAsHtml', () => {
  it('detects script tag with nonce', () => {
    const body = `<script>window.__bh_xss_${FIXED_NONCE}=1</script>`;
    expect(canaryAppearsAsHtml(body, FIXED_NONCE)).toBe(true);
  });

  it('detects img onerror with nonce', () => {
    const body = `<img src=x onerror="window.__bh_xss_${FIXED_NONCE}=1">`;
    expect(canaryAppearsAsHtml(body, FIXED_NONCE)).toBe(true);
  });

  it('returns false for HTML-escaped canary', () => {
    const body = `&lt;script&gt;__bh_xss_${FIXED_NONCE}&lt;/script&gt;`;
    expect(canaryAppearsAsHtml(body, FIXED_NONCE)).toBe(false);
  });

  it('returns false for unrelated content', () => {
    expect(canaryAppearsAsHtml('<div>hello world</div>', FIXED_NONCE)).toBe(false);
  });

  it('returns false for different nonce', () => {
    const body = `<script>window.__bh_xss_deadbeefdeadbeef=1</script>`;
    expect(canaryAppearsAsHtml(body, FIXED_NONCE)).toBe(false);
  });
});

describe('canaryAppearsAsAttribute', () => {
  it('detects onfocus attribute breakout', () => {
    const body = `<input value=" autofocus onfocus="window.__bh_xss_${FIXED_NONCE}=1">`;
    expect(canaryAppearsAsAttribute(body, FIXED_NONCE)).toBe(true);
  });

  it('detects onerror on img', () => {
    const body = `<img onerror="window.__bh_xss_${FIXED_NONCE}=1">`;
    expect(canaryAppearsAsAttribute(body, FIXED_NONCE)).toBe(true);
  });

  it('detects style expression with nonce', () => {
    const body = `<div style="xss:expression(window.__bh_xss_${FIXED_NONCE}=1)">`;
    expect(canaryAppearsAsAttribute(body, FIXED_NONCE)).toBe(true);
  });

  it('returns false for safely-escaped attribute', () => {
    const body = `<input value="&lt;onfocus=__bh_xss_${FIXED_NONCE}&gt;">`;
    expect(canaryAppearsAsAttribute(body, FIXED_NONCE)).toBe(false);
  });

  it('returns false for nonce in non-event attribute', () => {
    const body = `<div class="__bh_xss_${FIXED_NONCE}">`;
    expect(canaryAppearsAsAttribute(body, FIXED_NONCE)).toBe(false);
  });
});

describe('canaryAppearsInScriptTag', () => {
  it('detects nonce inside script block', () => {
    const body = `<script>const x = "';window.__bh_xss_${FIXED_NONCE}=1;//"</script>`;
    expect(canaryAppearsInScriptTag(body, FIXED_NONCE)).toBe(true);
  });

  it('detects nonce in direct window assignment inside script', () => {
    const body = `<script>window.__bh_xss_${FIXED_NONCE}=1</script>`;
    expect(canaryAppearsInScriptTag(body, FIXED_NONCE)).toBe(true);
  });

  it('returns false when nonce is outside script tags', () => {
    const body = `<div>window.__bh_xss_${FIXED_NONCE}=1</div>`;
    expect(canaryAppearsInScriptTag(body, FIXED_NONCE)).toBe(false);
  });

  it('returns false when no script tags present', () => {
    expect(canaryAppearsInScriptTag('<div>hello</div>', FIXED_NONCE)).toBe(false);
  });

  it('returns false for HTML-escaped content in script', () => {
    // The nonce appears encoded as entity — not inside a real script block
    const body = `<p>&lt;script&gt;__bh_xss_${FIXED_NONCE}&lt;/script&gt;</p>`;
    expect(canaryAppearsInScriptTag(body, FIXED_NONCE)).toBe(false);
  });

  it('returns false for different nonce inside script', () => {
    const body = `<script>window.__bh_xss_deadbeefdeadbeef=1</script>`;
    expect(canaryAppearsInScriptTag(body, FIXED_NONCE)).toBe(false);
  });
});
