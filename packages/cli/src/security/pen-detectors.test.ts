// Unit tests for v0.16 pen-testing detectors (pen-detectors.ts).
// Covers: SQL injection, command injection, path traversal, JWT weak-alg.
// Per spec §6.1: each variant gets positive + negative (null nonce) + clean-response tests.

import { describe, it, expect } from 'vitest';
import {
  detectSqlInjectionError,
  detectSqlInjectionBoolean,
  detectCommandInjection,
  detectPathTraversal,
  detectJwtWeakAlg,
  BOOLEAN_DELTA_THRESHOLD,
} from './pen-detectors.js';
import type { ProbeResponse } from './pen-detectors.js';
import type { PenPayload } from './injection-palette.js';

const NONCE = 'aabbccddeeff0011';
const ENDPOINT = 'GET /search';
const PARAM = 'q';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sqlPayload(variant: string): PenPayload {
  return { kind: 'sql', variant, nonce: NONCE, value: `' BUGHUNTER_${NONCE} --` };
}

function cmdPayload(variant: string): PenPayload {
  return { kind: 'cmd', variant, nonce: NONCE, value: `; echo BUGHUNTER_${NONCE}` };
}

function pathPayload(variant: string): PenPayload {
  return { kind: 'path', variant, nonce: NONCE, value: '../../../etc/passwd' };
}

function jwtPayload(variant: string): PenPayload {
  return { kind: 'jwt', variant, nonce: NONCE, value: `header.payload.` };
}

function ok200(body: string): ProbeResponse { return { status: 200, body }; }
function ok500(body: string): ProbeResponse { return { status: 500, body }; }
function err400(body: string): ProbeResponse { return { status: 400, body }; }

// ---------------------------------------------------------------------------
// SQL injection — error-based
// ---------------------------------------------------------------------------

describe('detectSqlInjectionError', () => {
  it('fires when nonce + SQL error fingerprint both present', () => {
    const body = `SQLite error: near "BUGHUNTER_${NONCE}": syntax error`;
    const result = detectSqlInjectionError(sqlPayload('error_quote'), ok500(body), PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('sql_injection');
      expect(result.detection.injectionContext?.proof).toBe('error_string');
      expect(result.detection.injectionContext?.nonce).toBe(NONCE);
      expect(result.detection.injectionContext?.variant).toBe('error_quote');
    }
  });

  it('does NOT fire when nonce present but no SQL error fingerprint', () => {
    const body = `Result: BUGHUNTER_${NONCE} found`;
    const result = detectSqlInjectionError(sqlPayload('error_quote'), ok200(body), PARAM, ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('does NOT fire when SQL error fingerprint present but nonce absent', () => {
    const body = `syntax error near "foo"`;
    const result = detectSqlInjectionError(sqlPayload('error_quote'), ok500(body), PARAM, ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('does NOT fire on a clean response', () => {
    const result = detectSqlInjectionError(sqlPayload('error_quote'), ok200('{"users":[]}'), PARAM, ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('fires on error_double_quote variant', () => {
    const payload: PenPayload = { kind: 'sql', variant: 'error_double_quote', nonce: NONCE, value: `" BUGHUNTER_${NONCE} --` };
    const body = `PostgreSQL: syntax error near "BUGHUNTER_${NONCE}"`;
    const result = detectSqlInjectionError(payload, ok500(body), PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('fires on union_select_marker variant when nonce + error present', () => {
    const payload: PenPayload = { kind: 'sql', variant: 'union_select_marker', nonce: NONCE, value: `' UNION SELECT 'BUGHUNTER_${NONCE}' --` };
    const body = `MySQL: syntax error near "BUGHUNTER_${NONCE}"`;
    const result = detectSqlInjectionError(payload, ok500(body), PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('fires on ORA- error fingerprint', () => {
    const body = `ORA-00907: missing right parenthesis BUGHUNTER_${NONCE}`;
    const result = detectSqlInjectionError(sqlPayload('error_quote'), ok500(body), PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('fires on MariaDB fingerprint', () => {
    const body = `MariaDB reported BUGHUNTER_${NONCE} near syntax error`;
    const result = detectSqlInjectionError(sqlPayload('error_quote'), ok500(body), PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('fires on "at line" fingerprint', () => {
    const body = `Error at line 1 BUGHUNTER_${NONCE}`;
    const result = detectSqlInjectionError(sqlPayload('error_quote'), ok500(body), PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('does NOT treat 500 alone as proof (no nonce in body)', () => {
    const result = detectSqlInjectionError(sqlPayload('error_quote'), ok500('Internal server error'), PARAM, ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('evidence field is capped at 200 chars', () => {
    const long = 'x'.repeat(500);
    const body = `syntax error BUGHUNTER_${NONCE} ${long}`;
    const result = detectSqlInjectionError(sqlPayload('error_quote'), ok500(body), PARAM, ENDPOINT);
    if (result.ok) {
      expect(result.detection.injectionContext!.evidence.length).toBeLessThanOrEqual(200);
    }
  });
});

// ---------------------------------------------------------------------------
// SQL injection — boolean-based
// ---------------------------------------------------------------------------

describe('detectSqlInjectionBoolean', () => {
  const truePayload: PenPayload = { kind: 'sql', variant: 'boolean_true', nonce: NONCE, value: `' OR '${NONCE}'='${NONCE}` };
  const falsePayload: PenPayload = { kind: 'sql', variant: 'boolean_false', nonce: NONCE, value: `' AND '${NONCE}'='other` };

  it('fires when true/false responses differ from baseline by ≥ threshold', () => {
    const baseline = ok200('a'.repeat(100));
    const trueResp = ok200('a'.repeat(200));   // 100% larger
    const falseResp = ok200('a'.repeat(80));   // 20% smaller
    const result = detectSqlInjectionBoolean(truePayload, trueResp, falseResp, baseline, PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('sql_injection');
      expect(result.detection.injectionContext?.proof).toBe('boolean_difference');
    }
  });

  it('does NOT fire when delta is below threshold', () => {
    const baseline = ok200('a'.repeat(100));
    const trueResp = ok200('a'.repeat(110));   // 10% — below 30%
    const falseResp = ok200('a'.repeat(95));   //  5% — below 30%
    const result = detectSqlInjectionBoolean(truePayload, trueResp, falseResp, baseline, PARAM, ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('does NOT fire when both variants are large but identical (no difference)', () => {
    const baseline = ok200('a'.repeat(100));
    const large = 'a'.repeat(200);
    const result = detectSqlInjectionBoolean(truePayload, ok200(large), ok200(large), baseline, PARAM, ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('does NOT fire when baseline is empty (division-by-zero guard)', () => {
    const result = detectSqlInjectionBoolean(truePayload, ok200('abc'), ok200(''), ok200(''), PARAM, ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('respects custom threshold parameter', () => {
    const baseline = ok200('a'.repeat(100));
    // 20% delta — below default 30%, above custom 15%
    const trueResp = ok200('a'.repeat(120));
    const falseResp = ok200('a'.repeat(85));
    const defaultResult = detectSqlInjectionBoolean(truePayload, trueResp, falseResp, baseline, PARAM, ENDPOINT);
    const customResult = detectSqlInjectionBoolean(truePayload, trueResp, falseResp, baseline, PARAM, ENDPOINT, 0.15);
    expect(defaultResult.ok).toBe(false);
    expect(customResult.ok).toBe(true);
  });

  it('BOOLEAN_DELTA_THRESHOLD is 0.3', () => {
    expect(BOOLEAN_DELTA_THRESHOLD).toBe(0.3);
  });
});

// ---------------------------------------------------------------------------
// Command injection
// ---------------------------------------------------------------------------

describe('detectCommandInjection', () => {
  it('fires when nonce literal appears in response body', () => {
    const body = `host: localhost\nBUGHUNTER_${NONCE}\n`;
    const result = detectCommandInjection(cmdPayload('shell_pipe_echo'), ok200(body), PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('command_injection');
      expect(result.detection.injectionContext?.proof).toBe('output_marker');
    }
  });

  it('does NOT fire when nonce is absent', () => {
    const result = detectCommandInjection(cmdPayload('shell_pipe_echo'), ok200('host: localhost'), PARAM, ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('does NOT fire on a clean 200 response', () => {
    const result = detectCommandInjection(cmdPayload('shell_amp_echo'), ok200('{}'), PARAM, ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('fires on shell_subshell_echo variant', () => {
    const payload: PenPayload = { kind: 'cmd', variant: 'shell_subshell_echo', nonce: NONCE, value: `$(echo BUGHUNTER_${NONCE})` };
    const result = detectCommandInjection(payload, ok200(`output: BUGHUNTER_${NONCE}`), PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('fires on shell_backtick_echo variant', () => {
    const payload: PenPayload = { kind: 'cmd', variant: 'shell_backtick_echo', nonce: NONCE, value: `\`echo BUGHUNTER_${NONCE}\`` };
    const result = detectCommandInjection(payload, ok200(`BUGHUNTER_${NONCE}`), PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('fires on shell_pipe_uniq_marker variant', () => {
    const payload: PenPayload = { kind: 'cmd', variant: 'shell_pipe_uniq_marker', nonce: NONCE, value: `| printf 'BUGHUNTER_${NONCE}'` };
    const result = detectCommandInjection(payload, ok200(`BUGHUNTER_${NONCE}`), PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('detection includes nonce in injectionContext', () => {
    const result = detectCommandInjection(cmdPayload('shell_pipe_echo'), ok200(`BUGHUNTER_${NONCE}`), PARAM, ENDPOINT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.injectionContext?.nonce).toBe(NONCE);
    }
  });
});

// ---------------------------------------------------------------------------
// Path traversal
// ---------------------------------------------------------------------------

describe('detectPathTraversal', () => {
  it('fires on /etc/passwd content in 2xx response (root:x:0:0)', () => {
    const body = 'root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin';
    const result = detectPathTraversal(pathPayload('linux_etc_passwd_relative'), ok200(body), 'name', ENDPOINT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('path_traversal');
      expect(result.detection.injectionContext?.proof).toBe('file_content');
    }
  });

  it('fires on nobody:x: fingerprint', () => {
    const body = 'nobody:x:65534:65534:nobody:/nonexistent:/usr/sbin/nologin';
    const result = detectPathTraversal(pathPayload('linux_etc_passwd_relative'), ok200(body), 'name', ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('fires on daemon:x: fingerprint', () => {
    const body = 'daemon:x:2:2:daemon:/sbin:/sbin/nologin';
    const result = detectPathTraversal(pathPayload('linux_etc_passwd_relative'), ok200(body), 'name', ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('fires on [fonts] (win.ini) fingerprint', () => {
    const body = '[fonts]\r\n[extensions]\r\n';
    const result = detectPathTraversal(pathPayload('windows_win_ini'), ok200(body), 'name', ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('fires on [mail] (win.ini) fingerprint', () => {
    const body = '[mail]\r\nSMTPPort=25\r\n';
    const result = detectPathTraversal(pathPayload('windows_win_ini'), ok200(body), 'name', ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('does NOT fire when fingerprint is present but response is not 2xx', () => {
    const body = 'root:x:0:0:root:/root:/bin/bash';
    // Server blocked the traversal but returned file metadata in error — NOT a finding
    const result = detectPathTraversal(pathPayload('linux_etc_passwd_relative'), err400(body), 'name', ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('does NOT fire on a clean 200 response', () => {
    const result = detectPathTraversal(pathPayload('linux_etc_passwd_relative'), ok200('Hello world'), 'name', ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('does NOT fire on 5xx response even with fingerprint', () => {
    const body = 'root:x:0:0 internal error';
    const result = detectPathTraversal(pathPayload('linux_etc_passwd_relative'), ok500(body), 'name', ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('fires on url_encoded_dotdot variant', () => {
    const payload: PenPayload = { kind: 'path', variant: 'url_encoded_dotdot', nonce: NONCE, value: '%2e%2e%2fetc%2fpasswd' };
    const result = detectPathTraversal(payload, ok200('root:x:0:0:root'), 'name', ENDPOINT);
    expect(result.ok).toBe(true);
  });

  it('fires on null_byte_termination variant', () => {
    const payload: PenPayload = { kind: 'path', variant: 'null_byte_termination', nonce: NONCE, value: '../../../etc/passwd\x00' };
    const result = detectPathTraversal(payload, ok200('root:x:0:0'), 'name', ENDPOINT);
    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// JWT weak algorithm
// ---------------------------------------------------------------------------

describe('detectJwtWeakAlg', () => {
  it('fires on alg_none_unsigned with 200 response (proof: unsigned_accepted)', () => {
    const result = detectJwtWeakAlg(jwtPayload('alg_none_unsigned'), ok200('{"promoted":true}'), ENDPOINT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.detection.kind).toBe('jwt_weak_alg');
      expect(result.detection.injectionContext?.proof).toBe('unsigned_accepted');
    }
  });

  it('fires on alg_none_lowercase variant', () => {
    const result = detectJwtWeakAlg(jwtPayload('alg_none_lowercase'), ok200('{"ok":true}'), ENDPOINT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detection.injectionContext?.proof).toBe('unsigned_accepted');
  });

  it('fires on alg_none_mixed_case variant', () => {
    const result = detectJwtWeakAlg(jwtPayload('alg_none_mixed_case'), ok200('{}'), ENDPOINT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detection.injectionContext?.proof).toBe('unsigned_accepted');
  });

  it('fires on weak_hmac_short_secret with proof: weak_secret_<value>', () => {
    const result = detectJwtWeakAlg(jwtPayload('weak_hmac_short_secret'), ok200('{}'), ENDPOINT, 'secret');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detection.injectionContext?.proof).toBe('weak_secret_secret');
  });

  it('fires on key_confusion_rs_to_hs with proof: rs_to_hs_confusion', () => {
    const result = detectJwtWeakAlg(jwtPayload('key_confusion_rs_to_hs'), ok200('{}'), ENDPOINT);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.detection.injectionContext?.proof).toBe('rs_to_hs_confusion');
  });

  it('does NOT fire when response is 401', () => {
    const result = detectJwtWeakAlg(jwtPayload('alg_none_unsigned'), { status: 401, body: 'Unauthorized' }, ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('does NOT fire when response is 403', () => {
    const result = detectJwtWeakAlg(jwtPayload('alg_none_unsigned'), { status: 403, body: 'Forbidden' }, ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('does NOT fire on 500 response', () => {
    const result = detectJwtWeakAlg(jwtPayload('alg_none_unsigned'), ok500('error'), ENDPOINT);
    expect(result.ok).toBe(false);
  });

  it('detection includes nonce in injectionContext', () => {
    const result = detectJwtWeakAlg(jwtPayload('alg_none_unsigned'), ok200('{}'), ENDPOINT);
    if (result.ok) {
      expect(result.detection.injectionContext?.nonce).toBe(NONCE);
    }
  });

  it('paramName is Authorization for JWT findings', () => {
    const result = detectJwtWeakAlg(jwtPayload('alg_none_unsigned'), ok200('{}'), ENDPOINT);
    if (result.ok) {
      expect(result.detection.injectionContext?.paramName).toBe('Authorization');
    }
  });
});
