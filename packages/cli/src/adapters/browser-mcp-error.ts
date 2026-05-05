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
  | 'browser_context_closed'  // Playwright/CDP context died (page closed, target closed, ws disconnected)
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
  // V56.4.x: detect browser-context-closed conditions ahead of generic 'timeout'
  // — if the underlying Playwright context dies, the SDK surfaces messages like
  // "browserContext closed", "Target page, context or browser has been closed",
  // "Page has been closed", or "Browser has been closed". Recovery means
  // reconnecting the MCP client (camofox-browser auto-relaunches the browser
  // process via its own health probe — see /opt/camofox-browser/server.js
  // restartBrowser()).
  if (
    lower.includes('browsercontext closed') ||
    lower.includes('target page, context') ||
    lower.includes('target closed') ||
    lower.includes('page has been closed') ||
    lower.includes('browser has been closed') ||
    lower.includes('connection closed') ||
    lower.includes('websocket') && lower.includes('closed')
  ) {
    return 'browser_context_closed';
  }
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
