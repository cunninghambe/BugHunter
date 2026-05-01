// Typed error for the CamofoxBrowserMcpAdapter.

export type BrowserMcpErrorKind =
  | 'transport'               // network / HTTP layer failure
  | 'no_tab'                  // navigate not called yet; adapter has no active tab
  | 'element_not_found'       // selector resolution failed in snapshot and DOM
  | 'element_not_actionable'  // ref found but click/type returned not-ok (disabled, covered, etc.)
  | 'navigation_failed'       // navigate returned ok:false or threw upstream
  | 'snapshot_failed'         // snapshot tool returned error envelope or 0 nodes
  | 'screenshot_failed'       // screenshot tool returned error envelope
  | 'evaluate_failed'         // evaluate threw inside the page
  | 'timeout'                 // upstream camofox timeout
  | 'unknown';                // anything else — raw error preserved in cause

export class BrowserMcpError extends Error {
  constructor(
    public readonly kind: BrowserMcpErrorKind,
    message: string,
    public readonly selector?: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'BrowserMcpError';
  }
}

/** Map a JSON-RPC error message from camofox (or SDK McpError.message) to a typed kind. */
export function classifyRpcError(message: string, toolName: string): BrowserMcpErrorKind {
  const lower = message.toLowerCase();
  if (lower.includes('timeout')) return 'timeout';
  if (lower.includes('not found') || lower.includes('no element')) return 'element_not_found';
  // SDK McpError code -32601: method/tool not found — treat as transport (tool typo on our end)
  if (lower.includes('-32601') || lower.includes('method not found')) return 'transport';
  // SDK McpError code -32700: parse error — transport-level failure
  if (lower.includes('-32700') || lower.includes('parse error')) return 'transport';
  if (toolName === 'screenshot') return 'screenshot_failed';
  if (toolName === 'snapshot') return 'snapshot_failed';
  return 'unknown';
}
