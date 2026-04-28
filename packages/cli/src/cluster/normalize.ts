// Normalisation functions for cluster signatures (§ 3.6).

// errorMessageNormalized: first 80 chars, lowercased, ids/strings/UUIDs stripped.
export function normalizeErrorMessage(message: string): string {
  let m = message.toLowerCase();
  // Strip UUIDs
  m = m.replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g, '<id>');
  // Strip hex SHA1 (40 hex chars)
  m = m.replace(/\b[0-9a-f]{40}\b/g, '<id>');
  // Strip numeric ids (4+ digits)
  m = m.replace(/\b\d{4,}\b/g, '<num>');
  // Strip double-quoted string literals
  m = m.replace(/"[^"]*"/g, '<str>');
  // Strip single-quoted string literals
  m = m.replace(/'[^']*'/g, '<str>');
  return m.slice(0, 80);
}

const FRAMEWORK_FRAME_PATTERN = /node_modules\/|webpack-internal:\/\/\/|react-dom|next\/dist\/|\.next\//;

// stackTraceFingerprint: strip line/column, filter framework frames, top-3 user-code frames.
export function fingerprintStackTrace(stack: string): string {
  const lines = stack
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('at '));

  const userFrames = lines
    .filter(l => !FRAMEWORK_FRAME_PATTERN.test(l))
    .slice(0, 3)
    .map(normalizeFrame);

  return userFrames.join('|');
}

// Strip line/column numbers and keep file + function only.
function normalizeFrame(frame: string): string {
  // "at FunctionName (file.ts:42:5)" or "at file.ts:42:5"
  let f = frame.replace(/^at\s+/, '');
  // Remove line:column at end
  f = f.replace(/:\d+:\d+\)?$/, '').replace(/:\d+\)?$/, '');
  // Remove surrounding parens
  f = f.replace(/^\(/, '').replace(/\)$/, '');
  f = f.trim();
  return f;
}

// responseBodyShape: depends on content-type.
export function shapeResponseBody(
  contentType: string,
  body: unknown
): string {
  if (contentType.includes('application/json')) {
    if (typeof body === 'object' && body !== null) {
      return Object.keys(body as Record<string, unknown>).sort().join(',');
    }
    return '';
  }
  if (contentType.includes('text/html')) {
    const s = String(body ?? '');
    const pre = /<pre[^>]*>([\s\S]{0,80})/i.exec(s)?.[1];
    if (pre !== undefined) return pre.slice(0, 80);
    const title = /<title>([^<]+)<\/title>/i.exec(s)?.[1];
    if (title !== undefined) return title;
  }
  // Else: first 12 hex of a naive hash of the first 200 chars
  return naiveHash(String(body ?? '').slice(0, 200));
}

function naiveHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}
