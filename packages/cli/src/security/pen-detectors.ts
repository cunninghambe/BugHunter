// Pure detection functions for v0.16 active pen-testing palette.
// No IO — each detector accepts a probe payload + HTTP response and returns a detection or null.

import type { BugDetection, InjectionDetectionContext } from '../types.js';
import type { PenPayload } from './injection-palette.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Response shape passed to every detector. */
export type ProbeResponse = {
  status: number;
  /** Full response body as a string. JSON bodies should be JSON.stringify'd. */
  body: string;
};

/** Discriminated union returned by all detectors. */
export type DetectorResult =
  | { ok: true; detection: BugDetection }
  | { ok: false };

const NOT_FOUND: DetectorResult = { ok: false };

function snippet(body: string, match: string): string {
  const idx = body.indexOf(match);
  if (idx === -1) return body.slice(0, 200);
  const start = Math.max(0, idx - 40);
  const end = Math.min(body.length, idx + match.length + 40);
  return body.slice(start, end).slice(0, 200);
}

function makeDetection(
  kind: BugDetection['kind'],
  rootCause: string,
  endpoint: string,
  ctx: InjectionDetectionContext,
): BugDetection {
  return { kind, rootCause, endpoint, injectionContext: ctx };
}

// ---------------------------------------------------------------------------
// SQL injection detector
// ---------------------------------------------------------------------------

/**
 * SQL-error fingerprints that indicate the database reflected our payload
 * inside an error message. Maintained as a constant; concise.
 */
const SQL_ERROR_FINGERPRINTS: RegExp[] = [
  /unrecognized token/i,
  /syntax error/i,
  /mismatched input/i,
  /Microsoft OLE DB Provider/i,
  /ORA-\d{4,}/,
  /PostgreSQL/i,
  /MariaDB/i,
  /MySQL/i,
  /near "BUGHUNTER/i,
  /at line \d/i,
];

/** Threshold for boolean-difference detection (fractional body-length change). */
export const BOOLEAN_DELTA_THRESHOLD = 0.3;

function hasSqlErrorFingerprint(body: string): boolean {
  return SQL_ERROR_FINGERPRINTS.some(re => re.test(body));
}

/**
 * Detect SQL injection from an error-based or union-select probe.
 * Returns a detection when BOTH:
 *   1. The nonce string "BUGHUNTER_<nonce>" appears in the response body.
 *   2. A SQL-error fingerprint appears in the response body.
 */
export function detectSqlInjectionError(
  payload: PenPayload,
  response: ProbeResponse,
  paramName: string,
  endpoint: string,
): DetectorResult {
  const marker = `BUGHUNTER_${payload.nonce}`;
  if (!response.body.includes(marker)) return NOT_FOUND;
  if (!hasSqlErrorFingerprint(response.body)) return NOT_FOUND;

  const ctx: InjectionDetectionContext = {
    paramName,
    variant: payload.variant,
    nonce: payload.nonce,
    proof: 'error_string',
    evidence: snippet(response.body, marker),
  };
  return {
    ok: true,
    detection: makeDetection(
      'sql_injection',
      `SQL injection (${payload.variant}): nonce BUGHUNTER_${payload.nonce} reflected inside SQL error at ${endpoint} param '${paramName}'.`,
      endpoint,
      ctx,
    ),
  };
}

/**
 * Detect SQL injection from union-select: nonce appears in a 2xx response
 * body along with a SQL error fingerprint (same rule) OR standalone echo.
 * For union_select_marker the nonce may appear without an error if the value
 * is returned in a SELECT result — we still require error fingerprint per spec §3.2.
 * (Union without error → reflected-XSS territory handled by XSS observer.)
 */
export function detectSqlInjectionUnionSelect(
  payload: PenPayload,
  response: ProbeResponse,
  paramName: string,
  endpoint: string,
): DetectorResult {
  // Delegate to error-based detector — union payloads fire on same two conditions.
  return detectSqlInjectionError(payload, response, paramName, endpoint);
}

/**
 * Detect SQL injection from boolean-based probes.
 * Requires both the true-variant response and the false-variant response.
 * Fires when the fractional body-length difference exceeds BOOLEAN_DELTA_THRESHOLD.
 */
export function detectSqlInjectionBoolean(
  truePayload: PenPayload,
  trueResponse: ProbeResponse,
  falseResponse: ProbeResponse,
  baselineResponse: ProbeResponse,
  paramName: string,
  endpoint: string,
  threshold: number = BOOLEAN_DELTA_THRESHOLD,
): DetectorResult {
  const baseLen = baselineResponse.body.length;
  if (baseLen === 0) return NOT_FOUND;

  const trueLen = trueResponse.body.length;
  const falseLen = falseResponse.body.length;
  const trueDelta = Math.abs(trueLen - baseLen) / baseLen;
  const falseDelta = Math.abs(falseLen - baseLen) / baseLen;

  // Both variants must differ from baseline by ≥ threshold AND differ from each other.
  if (trueDelta < threshold && falseDelta < threshold) return NOT_FOUND;
  if (Math.abs(trueLen - falseLen) / baseLen < threshold) return NOT_FOUND;

  const ctx: InjectionDetectionContext = {
    paramName,
    variant: truePayload.variant,
    nonce: truePayload.nonce,
    proof: 'boolean_difference',
    evidence: `baseline=${baseLen}bytes true=${trueLen}bytes false=${falseLen}bytes delta=${Math.round(Math.max(trueDelta, falseDelta) * 100)}%`,
  };
  return {
    ok: true,
    detection: makeDetection(
      'sql_injection',
      `SQL injection (boolean-based): response body size differs by ≥${Math.round(threshold * 100)}% between tautology variants at ${endpoint} param '${paramName}'.`,
      endpoint,
      ctx,
    ),
  };
}

// ---------------------------------------------------------------------------
// Command injection detector
// ---------------------------------------------------------------------------

/**
 * Detect command injection: the nonce string "BUGHUNTER_<nonce>" is literally
 * present in the response body (server executed and echoed the payload).
 */
export function detectCommandInjection(
  payload: PenPayload,
  response: ProbeResponse,
  paramName: string,
  endpoint: string,
): DetectorResult {
  const marker = `BUGHUNTER_${payload.nonce}`;
  if (!response.body.includes(marker)) return NOT_FOUND;

  const ctx: InjectionDetectionContext = {
    paramName,
    variant: payload.variant,
    nonce: payload.nonce,
    proof: 'output_marker',
    evidence: snippet(response.body, marker),
  };
  return {
    ok: true,
    detection: makeDetection(
      'command_injection',
      `Command injection (${payload.variant}): nonce BUGHUNTER_${payload.nonce} echoed in response body at ${endpoint} param '${paramName}'. Server executed the payload.`,
      endpoint,
      ctx,
    ),
  };
}

// ---------------------------------------------------------------------------
// Path traversal detector
// ---------------------------------------------------------------------------

/** File-content fingerprints indicating a successful read of a sensitive file. */
const PASSWD_FINGERPRINTS = ['root:x:0:0', 'nobody:x:', 'daemon:x:'];
const WININI_FINGERPRINTS = ['[fonts]', '[mail]'];

function hasFileContentFingerprint(body: string): boolean {
  return (
    PASSWD_FINGERPRINTS.some(f => body.includes(f)) ||
    WININI_FINGERPRINTS.some(f => body.includes(f))
  );
}

/**
 * Detect path traversal: the response is 2xx AND the body contains fingerprints
 * of /etc/passwd or windows/win.ini content.
 */
export function detectPathTraversal(
  payload: PenPayload,
  response: ProbeResponse,
  paramName: string,
  endpoint: string,
): DetectorResult {
  if (response.status < 200 || response.status >= 300) return NOT_FOUND;
  if (!hasFileContentFingerprint(response.body)) return NOT_FOUND;

  const matchedFingerprint =
    [...PASSWD_FINGERPRINTS, ...WININI_FINGERPRINTS].find(f => response.body.includes(f)) ?? '';

  const ctx: InjectionDetectionContext = {
    paramName,
    variant: payload.variant,
    nonce: payload.nonce,
    proof: 'file_content',
    evidence: snippet(response.body, matchedFingerprint),
  };
  return {
    ok: true,
    detection: makeDetection(
      'path_traversal',
      `Path traversal (${payload.variant}): server returned sensitive file content (fingerprint: '${matchedFingerprint}') at ${endpoint} param '${paramName}'. Severity: critical even on dev — review filesystem-access guards before deploy.`,
      endpoint,
      ctx,
    ),
  };
}

// ---------------------------------------------------------------------------
// JWT weak-algorithm detector
// ---------------------------------------------------------------------------

/**
 * Detect JWT weak-algorithm acceptance.
 *
 * For alg:none variants — a 200 response on a requiresAuth endpoint means
 * the unsigned token was accepted.
 *
 * For weak_hmac_short_secret — a 200 response means the server verified with
 * a known-weak secret.
 *
 * For key_confusion_rs_to_hs — a 200 response means the server accepted an
 * HS256 token signed with the public RSA key as HMAC secret.
 */
export function detectJwtWeakAlg(
  payload: PenPayload,
  response: ProbeResponse,
  endpoint: string,
  secretUsed?: string,
): DetectorResult {
  if (response.status !== 200) return NOT_FOUND;

  const proof = resolveJwtProof(payload.variant, secretUsed);
  const ctx: InjectionDetectionContext = {
    paramName: 'Authorization',
    variant: payload.variant,
    nonce: payload.nonce,
    proof,
    evidence: snippet(response.body, ''),
  };
  return {
    ok: true,
    detection: makeDetection(
      'jwt_weak_alg',
      `JWT weak algorithm (${payload.variant}): server accepted a forged token (proof: ${proof}) on ${endpoint}. Authentication bypass possible.`,
      endpoint,
      ctx,
    ),
  };
}

function resolveJwtProof(variant: string, secretUsed: string | undefined): string {
  if (variant.startsWith('alg_none')) return 'unsigned_accepted';
  if (variant === 'weak_hmac_short_secret') return `weak_secret_${secretUsed ?? 'unknown'}`;
  return 'rs_to_hs_confusion';
}
