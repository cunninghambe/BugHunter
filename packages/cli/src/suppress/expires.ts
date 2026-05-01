const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

export function parseExpires(input: string): string {
  if (ISO_RE.test(input)) {
    const d = new Date(input);
    if (isNaN(d.getTime())) throw new Error('expires must be YYYY-MM-DD or ISO 8601 datetime');
    return d.toISOString();
  }
  if (DATE_ONLY_RE.test(input)) {
    const d = new Date(`${input}T00:00:00.000Z`);
    if (isNaN(d.getTime())) throw new Error('expires must be YYYY-MM-DD or ISO 8601 datetime');
    return d.toISOString();
  }
  throw new Error('expires must be YYYY-MM-DD or ISO 8601 datetime');
}
