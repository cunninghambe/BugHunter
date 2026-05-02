/**
 * Browser MCP adapters — two implementations of BrowserMcpAdapter:
 *
 * - CamofoxBrowserMcpAdapter (v0.49 default): uses @modelcontextprotocol/sdk Client
 *   + StreamableHTTPClientTransport (mode:'http') or StdioClientTransport (mode:'stdio').
 *   Honest naming: this adapter actually speaks MCP.
 *
 * - CamofoxBrowserHttpAdapter (deprecated, was CamofoxBrowserMcpAdapter): hand-rolled
 *   JSON-RPC over fetch. Kept for one minor version (v0.49); deleted in v0.50.
 *   Use browserTransport:'http-legacy' to opt in; emits a deprecation warning.
 *
 * Factory: makeBrowserAdapter(config) returns the correct implementation.
 *
 * Public interface (BrowserMcpAdapter) is unchanged — all 42 call-sites compile
 * without modification. The 6 construction sites call makeBrowserAdapter(config) instead.
 *
 * URL convention: browserMcpUrl is the full MCP endpoint URL, e.g.
 * "http://127.0.0.1:3104/mcp". For the legacy adapter, baseUrl strips the trailing
 * "/mcp" and re-appends it internally (backward-compat).
 *
 * Concurrency: the SDK Client is concurrency-safe. Multiple callTool calls may be
 * in flight on one Client. Callers sharing the Client (parallel tests via withTab)
 * each bind their own tabId; no locking needed.
 *
 * dispose() must be called at run end (in a finally block). In-flight calls at
 * dispose time are best-effort: the SDK cancels them and they reject with a transport
 * error. The upstream phase is responsible for awaiting them before disposing.
 *
 * Do NOT log request/response bodies — they may contain cookies, JWTs, page content.
 * Log only {tool, ok, latencyMs} at TRACE level when needed.
 */

import * as fs from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  BrowserMcpError,
  classifyRpcError,
} from './browser-mcp-error.js';
import {
  parseSnapshot,
  resolveSelectorInSnapshot,
  resolveByHtml,
  toCamofoxScrollDirection,
} from './browser-mcp-snapshot.js';
import type { StructuredSelector, SnapshotNode } from './browser-mcp-snapshot.js';
import type { TriggerSelectorHint, NetworkFaultSpec, ApplyNetworkFaultResult } from '../types.js';
export type { NetworkFaultSpec, ApplyNetworkFaultResult };
import type { BugHunterConfig } from '../types.js';
import { runEvaluateClick } from '../phases/click-runner.js';
import type { EvaluateClickResult } from '../phases/click-runner.js';

export type NavigateResult = { url: string; title?: string };
export type ClickResult = { clicked: boolean };
export type TypeResult = { typed: boolean };
export type ScrollResult = { scrolled: boolean };
export type SnapshotResult = { snapshot: string };
export type ScreenshotResult = { path: string; data?: string };
export type EvaluateResult = { value: unknown };
export type ListTabsResult = { tabs: Array<{ id: string; url: string; title: string }> };
export type CloseTabResult = { closed: boolean };
export type ExtraHeaders = Record<string, string>;

export type ClickByHintResult =
  | { clicked: true; matchedBy: 'testId' | 'ariaLabel' | 'text' }
  | { clicked: false; reason: 'no_hint_fields' | 'not_found' };

export type CookieEntry = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
};
export type CookiesResult = { tabId: string; cookies: CookieEntry[] };

/** Per-test tab scope — all methods carry the bound tabId; safe to use concurrently. */
export type TabScope = {
  tabId: string;
  navigate(url: string, extraHeaders?: ExtraHeaders): Promise<NavigateResult>;
  click(selector: string | StructuredSelector): Promise<ClickResult>;
  type(selector: string | StructuredSelector, text: string): Promise<TypeResult>;
  scroll(selector: string, direction: 'up' | 'down', distance?: number): Promise<ScrollResult>;
  snapshot(): Promise<SnapshotResult>;
  screenshot(outputPath?: string): Promise<ScreenshotResult>;
  evaluate(script: string): Promise<EvaluateResult>;
  clickByHint(hint: TriggerSelectorHint): Promise<ClickByHintResult>;
  /**
   * v0.12: click with rich evaluate-result. Used by execute.ts to emit the
   * interactive_element_missing_accessible_name BugDetection. For structured
   * selectors, returns the degraded shape (accessibleNameAbsent:false) — the
   * named-selector path is inherently named.
   *
   * Optional: callers that do not need the observation result (e.g. vision-discovery
   * probes) may omit this method from their scope mocks.
   */
  clickWithObservation?(selector: string | StructuredSelector): Promise<EvaluateClickResult & { ok: true }>;
  /**
   * v0.20: install a network fault on the tab's browser context.
   * Optional — camofox-mcp v0.1 does not ship this tool; v0.2+ required.
   * Implementations MUST be idempotent — calling apply twice replaces the spec.
   */
  applyNetworkFault?(fault: NetworkFaultSpec): Promise<ApplyNetworkFaultResult>;
  /** v0.20: remove any network fault. Idempotent. Always succeeds (or throws transport). */
  clearNetworkFault?(): Promise<void>;
  /** v0.38: emulate a CSS media feature (e.g. prefers-color-scheme, forced-colors). Optional. */
  emulateMedia?(options: { media?: 'print' | 'screen' | null; features?: Array<{ name: string; value: string }> }): Promise<void>;
  /** v0.38: set browser zoom factor. Optional. */
  setZoom?(factor: number): Promise<void>;
  /** v0.38: dispatch a synthetic DOM event and return observed state. Optional. */
  dispatchSyntheticEvent?(selector: string, eventType: string, eventInit?: Record<string, unknown>): Promise<{ dispatched: boolean; defaultPrevented: boolean }>;
};

export interface BrowserMcpAdapter {
  navigate(url: string, extraHeaders?: ExtraHeaders): Promise<NavigateResult>;
  /** Preferred: pass structured {role, name?, nth?} for unambiguous resolution. */
  click(selector: string | StructuredSelector): Promise<ClickResult>;
  type(selector: string | StructuredSelector, text: string): Promise<TypeResult>;
  scroll(selector: string, direction: 'up' | 'down', distance?: number): Promise<ScrollResult>;
  snapshot(): Promise<SnapshotResult>;
  screenshot(outputPath?: string): Promise<ScreenshotResult>;
  evaluate(script: string): Promise<EvaluateResult>;
  listTabs(): Promise<ListTabsResult>;
  closeTab(tabId: string): Promise<CloseTabResult>;
  /** Open a new tab unconditionally; does not mutate currentTabId. */
  openTab(url: string, extraHeaders?: ExtraHeaders): Promise<{ tabId: string; finalUrl: string; title?: string }>;
  /** Close a specific tab by id; does not mutate currentTabId. */
  closeTabExplicit(tabId: string): Promise<void>;
  /**
   * Open a new isolated tab, call fn with a bound TabScope, then close the tab.
   * Closing happens even if fn throws (scope is always released).
   */
  withTab<T>(url: string, extraHeaders: ExtraHeaders | undefined, fn: (scope: TabScope) => Promise<T>): Promise<T>;

  /** Read the full cookie jar for the current tab's browser context, including HttpOnly cookies. */
  cookies(urls?: string[]): Promise<CookiesResult>;

  /**
   * Click an element identified by a TriggerSelectorHint via browser.evaluate.
   * Hint priority: testId → ariaLabel → text. For each populated field, walks
   * the live DOM and dispatches a synthetic MouseEvent('click', {bubbles:true,
   * cancelable:true, view:window, button:0}) on the first visible match.
   *
   * Returns `{clicked:true, matchedBy}` on success or `{clicked:false, reason}`
   * when no hint field is set or no element matched any populated field.
   * Never throws BrowserMcpError; transport errors propagate unchanged.
   *
   * Backward compat: this is additive. Existing callers of `click(selector)`
   * are unchanged. The snapshot/ref pipeline is NOT used.
   */
  clickByHint(hint: TriggerSelectorHint): Promise<ClickByHintResult>;
  /**
   * v0.17: resize the singleton tab to the given viewport dimensions.
   * Uses window.resizeTo + dispatchEvent('resize') fallback (camofox v0.1 has no set_viewport tool).
   * Optional to avoid breaking existing test mocks that predate v0.17.
   */
  setViewport?(width: number, height: number): Promise<{ ok: true } | { ok: false; reason: string }>;

  /**
   * v0.19: register a forced response for requests matching the given scope.
   * Scope is narrowed to (method + path + optional request-body hash) to avoid
   * intercepting unrelated requests (EC-9).
   *
   * Returns a function that unregisters the fulfillment when called. MUST be called
   * after the test to restore normal request behaviour.
   *
   * Optional: if the camofox MCP build does not expose route interception, this method
   * will be undefined and the optimistic_revert variant is skipped with
   * skipReason 'no_route_fulfill_support' (EC-10).
   */
  routeFulfill?(scope: RouteFulfillScope, response: RouteFulfillResponse): Promise<UnregisterFn>;

  /**
   * v0.23: set timezone override via Emulation.setTimezoneOverride (CDP passthrough).
   * Returns { applied: true } when applied at CDP level, or { applied: false, degraded }
   * when the underlying MCP does not support the tool and a JS fallback was used.
   *
   * Pass null to clear any previously-set override.
   */
  setTimezoneOverride?(tz: string | null): Promise<{ applied: boolean; degraded?: 'evaluate_intl' | 'unsupported' }>;

  /**
   * v0.23: install an init script via Page.addScriptToEvaluateOnNewDocument.
   * Returns { applied: true } when the script will run before app code, or
   * { applied: false, degraded: 'late_inject' } when the MCP lacks support and
   * evaluate() was used immediately (after-navigate fallback — race risk).
   */
  addInitScript?(source: string): Promise<{ applied: boolean; degraded?: 'late_inject' | 'unsupported' }>;

  /**
   * v0.20: install a network fault on the tab's browser context.
   * Optional — camofox-mcp v0.1 does not expose this tool; v0.2+ required.
   * Implementations MUST be idempotent — calling apply twice replaces the spec.
   */
  applyNetworkFault?(fault: NetworkFaultSpec): Promise<ApplyNetworkFaultResult>;
  /** v0.20: remove any network fault. Idempotent. Always succeeds (or throws transport). */
  clearNetworkFault?(): Promise<void>;

  /**
   * v0.38: emulate CSS media features (e.g. prefers-color-scheme, prefers-reduced-motion,
   * forced-colors, print). Optional — absent on adapters that predate v0.38.
   * When absent, interaction-palette env variants skip with skipReason 'adapter_unsupported'.
   */
  emulateMedia?(options: {
    media?: 'print' | 'screen' | null;
    features?: Array<{ name: string; value: string }>;
  }): Promise<void>;

  /**
   * v0.38: set browser zoom level. factor=2.0 = 200% zoom.
   * Optional — absent on adapters that predate v0.38.
   * When absent, zoom_200 interaction-palette variants skip with skipReason 'adapter_unsupported'.
   */
  setZoom?(factor: number): Promise<void>;

  /**
   * v0.38: dispatch a synthetic DOM event on the given selector.
   * Optional — absent on adapters that predate v0.38.
   * When absent, drag/paste/autofill interaction-palette variants skip with skipReason 'adapter_unsupported'.
   */
  dispatchSyntheticEvent?(
    selector: string,
    eventType: string,
    eventInit?: Record<string, unknown>,
  ): Promise<{ dispatched: boolean; defaultPrevented: boolean }>;
}

/** Scope narrows which requests are intercepted. All fields are ANDed. */
export type RouteFulfillScope = {
  method: string;
  /** URL path pattern (prefix or exact). */
  path: string;
  /** SHA1 of expected request body (first 200 bytes). When set, only matching bodies are intercepted. */
  bodyHash?: string;
};

export type RouteFulfillResponse = {
  status: number;
  body: string;
  contentType?: string;
};

/** Call to remove the route interception installed by routeFulfill. */
export type UnregisterFn = () => Promise<void>;

// ---- Raw camofox result shapes (shared by both adapters) ----

type CamofoxNavigateResult = { tabId: string; ok?: boolean; finalUrl?: string; url?: string; title?: string };
type CamofoxSnapshotResult = { tabId: string; snapshot: string };
type CamofoxScreenshotResult = { tabId: string; dataUrl?: string };
type CamofoxEvaluateResult = { tabId: string; result?: unknown; value?: unknown };
type CamofoxListTabsResult = { tabs: Array<{ tabId?: string; id?: string; url: string; title: string }> };

// ---- MCP SDK content block shape ----

type SdkContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [key: string]: unknown };

type SdkCallToolResult = {
  content: SdkContentBlock[];
  isError?: boolean;
  [key: string]: unknown;
};

// ---- SDK-based content parsers (used by CamofoxBrowserMcpAdapter) ----

function sdkTextOf(content: SdkContentBlock[]): string | undefined {
  for (const block of content) {
    if (block.type === 'text' && 'text' in block) return String(block.text);
  }
  return undefined;
}

function sdkParseText<T>(result: SdkCallToolResult, tool: string): T {
  const text = sdkTextOf(result.content);
  if (text === undefined || text === '') {
    throw new BrowserMcpError('transport', `No text content in camofox response for ${tool}`);
  }
  return JSON.parse(text) as T;
}

function sdkParseImage(result: SdkCallToolResult): { dataUrl: string } {
  const block = result.content.find(b => b.type === 'image');
  if (block?.type === 'image') {
    return { dataUrl: `data:${block.mimeType};base64,${block.data}` };
  }
  // Fallback: text content may contain a JSON object with dataUrl
  const text = sdkTextOf(result.content);
  if (text !== undefined && text !== '') {
    const parsed = JSON.parse(text) as { dataUrl?: string };
    return { dataUrl: parsed.dataUrl ?? '' };
  }
  throw new BrowserMcpError('screenshot_failed', 'No image content in camofox screenshot response');
}

/** Strip Authorization / Cookie values from an error message (EC-7). */
function sanitizeErrorMessage(msg: string): string {
  return msg
    .replace(/Authorization:\s*Bearer\s+\S+/gi, 'Authorization: Bearer [REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, 'Bearer [REDACTED]')
    .replace(/Cookie:\s*\S+/gi, 'Cookie: [REDACTED]');
}

// ---- CamofoxBrowserMcpAdapter — SDK Client transport (v0.49 default) ----

type McpAdapterOpts = {
  mode: 'http' | 'stdio';
  /** HTTP mode: full MCP endpoint URL (e.g. "http://127.0.0.1:3104/mcp"). */
  url?: string;
  /** Stdio mode: path to the camofox-mcp binary. */
  command?: string;
  /** Stdio mode: CLI arguments for the binary. */
  args?: string[];
  /** Stdio mode: additional environment variables for the subprocess. */
  env?: Record<string, string>;
  /** Bearer token for Authorization header. Falls back to CAMOFOX_MCP_KEY env var. */
  authKey?: string;
  /** Extra HTTP headers forwarded to the transport (HTTP mode only). */
  extraHeaders?: Record<string, string>;
};

export class CamofoxBrowserMcpAdapter implements BrowserMcpAdapter {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport | StdioClientTransport;
  private currentTabId?: string;
  private connectPromise?: Promise<void>;
  private readonly opts: McpAdapterOpts;
  /**
   * Backward-compat: callers that passed a bare URL string pre-v49 get a
   * CamofoxBrowserHttpAdapter delegate so existing tests and call-sites continue to work.
   * The delegate is used for all BrowserMcpAdapter interface methods.
   */
  private readonly legacyDelegate?: CamofoxBrowserHttpAdapter;

  /**
   * Accepts either a full McpAdapterOpts object (v0.49+) or a bare URL string
   * (pre-v49 compat). String form delegates to CamofoxBrowserHttpAdapter internally.
   */
  constructor(opts: McpAdapterOpts | string) {
    if (typeof opts === 'string') {
      this.opts = { mode: 'http', url: opts };
      this.legacyDelegate = new CamofoxBrowserHttpAdapter(opts);
    } else {
      this.opts = opts;
    }
  }

  // ---- Connection lifecycle ----

  private async connect(): Promise<void> {
    const client = new Client({ name: 'bughunter', version: '0.49.0' }, { capabilities: {} });

    if (this.opts.mode === 'http') {
      const url = new URL(this.opts.url ?? 'http://127.0.0.1:3104/mcp');
      const authKey = this.opts.authKey ?? process.env['CAMOFOX_MCP_KEY'];
      const headers: Record<string, string> = {
        ...(authKey !== undefined ? { Authorization: `Bearer ${authKey}` } : {}),
        ...(this.opts.extraHeaders ?? {}),
      };
      const transport = new StreamableHTTPClientTransport(url, {
        requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
      });
      this.transport = transport;
      await client.connect(transport);
    } else {
      if (this.opts.command === undefined) {
        throw new BrowserMcpError('transport', 'browserMcpStdio.command is required for mcp-stdio transport');
      }
      const transport = new StdioClientTransport({
        command: this.opts.command,
        args: this.opts.args,
        env: this.opts.env,
        stderr: 'inherit',
      });
      this.transport = transport;
      try {
        await client.connect(transport);
      } catch (err) {
        throw new BrowserMcpError(
          'transport',
          `camofox-mcp subprocess failed to start: ${sanitizeErrorMessage(String(err))}`,
          undefined,
          err,
        );
      }
    }

    this.client = client;
  }

  private async ensureConnected(): Promise<Client> {
    if (this.client !== undefined) return this.client;
    // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
    if (this.connectPromise === undefined) {
      this.connectPromise = this.connect();
    }
    await this.connectPromise;
    // connect() sets this.client synchronously before resolving — the eslint rule cannot see this
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    return this.client!;
  }

  async dispose(): Promise<void> {
    if (this.legacyDelegate !== undefined) return; // legacy adapter has no resources to release
    const c = this.client;
    const t = this.transport;
    this.client = undefined;
    this.transport = undefined;
    this.connectPromise = undefined;
    if (c !== undefined) await c.close().catch(() => {});
    if (t !== undefined) await t.close().catch(() => {});
  }

  // ---- Generic tool dispatcher (internal — accessible by V20/V22/V23 callers) ----

  async tool<T>(name: string, args: Record<string, unknown>, expect: 'json' | 'image' = 'json'): Promise<T> {
    const client = await this.ensureConnected();
    let res: SdkCallToolResult;
    try {
      res = await client.callTool({ name, arguments: args }) as SdkCallToolResult;
    } catch (err) {
      throw new BrowserMcpError(
        'transport',
        `camofox ${name} transport error: ${sanitizeErrorMessage(String(err))}`,
        undefined,
        err,
      );
    }
    if (res.isError === true) {
      const msg = sdkTextOf(res.content) ?? 'Unknown MCP tool error';
      throw new BrowserMcpError(classifyRpcError(msg, name), `camofox ${name} error: ${msg}`);
    }
    if (expect === 'image') return sdkParseImage(res) as T;
    return sdkParseText<T>(res, name);
  }

  // ---- Private helpers ----

  private requireTab(): string {
    if (this.currentTabId === undefined) {
      throw new BrowserMcpError('no_tab', 'Adapter has no active tab; call navigate(url) first');
    }
    return this.currentTabId;
  }

  private async resolveRef(tabId: string, selector: string | StructuredSelector): Promise<string> {
    const raw = await this.tool<CamofoxSnapshotResult>('snapshot', { tabId });
    const nodes = parseSnapshot(raw.snapshot);
    if (nodes.length === 0) {
      throw new BrowserMcpError('snapshot_failed', 'Snapshot parsed 0 elements; tab may have crashed');
    }
    const ref = resolveSelectorInSnapshot(selector, nodes);
    if (ref !== null) return ref;

    if (typeof selector !== 'string') {
      throw new BrowserMcpError('element_not_found', 'No matching ref in snapshot', String(selector));
    }
    return this.resolveViaEvaluate(tabId, selector, nodes);
  }

  private async resolveViaEvaluate(tabId: string, selector: string, _nodes: SnapshotNode[]): Promise<string> {
    const safeSelector = selector.replace(/'/g, "\\'");
    const expr = `document.querySelector('${safeSelector}')?.outerHTML?.slice(0, 200) ?? null`;
    let evalResult: CamofoxEvaluateResult;
    try {
      evalResult = await this.tool<CamofoxEvaluateResult>('evaluate', { tabId, expression: expr });
    } catch {
      throw new BrowserMcpError('element_not_found', 'No matching ref in snapshot or DOM', selector);
    }

    const html = String(evalResult.result ?? evalResult.value ?? '');
    if (html === '' || html === 'null') {
      throw new BrowserMcpError('element_not_found', 'No matching ref in snapshot or DOM', selector);
    }

    const fresh = await this.tool<CamofoxSnapshotResult>('snapshot', { tabId });
    const freshNodes = parseSnapshot(fresh.snapshot);
    const tagMatch = /^\.?(\w+)/.exec(selector);
    const tag = tagMatch?.[1] ?? 'div';
    const ref = resolveByHtml(html, tag, freshNodes);
    if (ref === null) {
      throw new BrowserMcpError(
        'element_not_found',
        'Element exists in DOM but has no accessible name in snapshot',
        selector,
      );
    }
    return ref;
  }

  private makeEvaluateScope(tabId: string) {
    return {
      evaluate: (script: string) =>
        this.tool<CamofoxEvaluateResult>('evaluate', { tabId, expression: script }).then(r => ({
          value: r.result ?? r.value,
        })),
    };
  }

  private static escapeAttr(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private async evaluateClickByCss(tabId: string, css: string): Promise<boolean> {
    const expr = `(function(){var el=document.querySelector(${JSON.stringify(css)});if(!el)return false;var r=el.getBoundingClientRect();if(el.offsetParent===null&&(r.width===0||r.height===0))return false;el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0}));return true;})()`;
    try {
      const result = await this.tool<CamofoxEvaluateResult>('evaluate', { tabId, expression: expr });
      return (result.result ?? result.value) === true;
    } catch {
      return false;
    }
  }

  private async evaluateClickByText(tabId: string, text: string): Promise<boolean> {
    const expr = `(function(){var text=${JSON.stringify(text.toLowerCase())};var sel='button, a, [role="button"], [role="tab"], [role="link"]';var els=Array.from(document.querySelectorAll(sel));function visible(el){var r=el.getBoundingClientRect();return el.offsetParent!==null||(r.width>0&&r.height>0);}var candidates=els.filter(visible);var target=candidates.find(function(el){return(el.textContent||'').trim().toLowerCase()===text;})||candidates.find(function(el){return(el.textContent||'').toLowerCase().includes(text);});if(!target)return false;target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0}));return true;})()`;
    try {
      const result = await this.tool<CamofoxEvaluateResult>('evaluate', { tabId, expression: expr });
      return (result.result ?? result.value) === true;
    } catch {
      return false;
    }
  }

  // ---- Public interface ----

  async navigate(url: string, extraHeaders?: ExtraHeaders): Promise<NavigateResult> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.navigate(url, extraHeaders);
    // extraHeaders silently dropped — camofox v0.1 has no per-tab header support.
    // When extraHeaders is non-empty, the no-op is intentional (EC-14).
    const args: Record<string, unknown> = this.currentTabId !== undefined
      ? { tabId: this.currentTabId, url }
      : { url };
    const result = await this.tool<CamofoxNavigateResult>('navigate', args);
    this.currentTabId = result.tabId;
    if (result.ok === false) {
      throw new BrowserMcpError('navigation_failed', `navigate returned ok:false for ${url}`);
    }
    return { url: result.finalUrl ?? result.url ?? url, title: result.title };
  }

  async click(selector: string | StructuredSelector): Promise<ClickResult> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.click(selector);
    const tabId = this.requireTab();
    if (typeof selector === 'string') {
      await runEvaluateClick(this.makeEvaluateScope(tabId), selector);
      return { clicked: true };
    }
    try {
      const ref = await this.resolveRef(tabId, selector);
      await this.tool<{ tabId: string; ok: boolean }>('click', { tabId, ref });
      return { clicked: true };
    } catch (err) {
      if (err instanceof BrowserMcpError && err.kind === 'element_not_found') {
        // Single retry after re-snapshot (dynamic-render race) — structured path only
        const ref = await this.resolveRef(tabId, selector);
        await this.tool<{ tabId: string; ok: boolean }>('click', { tabId, ref });
        return { clicked: true };
      }
      throw err;
    }
  }

  async type(selector: string | StructuredSelector, text: string): Promise<TypeResult> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.type(selector, text);
    const tabId = this.requireTab();
    try {
      const ref = await this.resolveRef(tabId, selector);
      await this.tool<{ tabId: string; ok: boolean }>('type', { tabId, ref, text, submit: false });
      return { typed: true };
    } catch (err) {
      if (err instanceof BrowserMcpError && err.kind === 'element_not_found') {
        const ref = await this.resolveRef(tabId, selector);
        await this.tool<{ tabId: string; ok: boolean }>('type', { tabId, ref, text, submit: false });
        return { typed: true };
      }
      throw err;
    }
  }

  async scroll(selector: string, direction: 'up' | 'down', distance?: number): Promise<ScrollResult> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.scroll(selector, direction, distance);
    const tabId = this.requireTab();
    await this.tool<{ tabId: string; ok: boolean }>('scroll', {
      tabId,
      direction: toCamofoxScrollDirection(direction),
      amount: distance ?? 500,
    });
    return { scrolled: true };
  }

  async snapshot(): Promise<SnapshotResult> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.snapshot();
    const tabId = this.requireTab();
    const result = await this.tool<CamofoxSnapshotResult>('snapshot', { tabId });
    return { snapshot: result.snapshot };
  }

  async screenshot(outputPath?: string): Promise<ScreenshotResult> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.screenshot(outputPath);
    const tabId = this.requireTab();
    const result = await this.tool<CamofoxScreenshotResult>('screenshot', { tabId, fullPage: false }, 'image');
    const base64 = result.dataUrl ?? '';
    if (outputPath !== undefined) {
      if (outputPath === '') throw new Error('screenshot: outputPath is empty — caller bug?');
      const pngData = base64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(outputPath, Buffer.from(pngData, 'base64'));
      return { path: outputPath, data: base64 };
    }
    return { path: '', data: base64 };
  }

  async evaluate(script: string): Promise<EvaluateResult> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.evaluate(script);
    const tabId = this.requireTab();
    const result = await this.tool<CamofoxEvaluateResult>('evaluate', { tabId, expression: script });
    return { value: result.result ?? result.value };
  }

  async listTabs(): Promise<ListTabsResult> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.listTabs();
    const result = await this.tool<CamofoxListTabsResult>('list_tabs', {});
    const tabs = result.tabs.map(t => ({
      id: t.tabId ?? t.id ?? '',
      url: t.url,
      title: t.title,
    }));
    return { tabs };
  }

  async closeTab(tabId: string): Promise<CloseTabResult> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.closeTab(tabId);
    await this.tool<{ ok: boolean }>('close_tab', { tabId });
    if (tabId === this.currentTabId) this.currentTabId = undefined;
    return { closed: true };
  }

  async openTab(url: string, extraHeaders?: ExtraHeaders): Promise<{ tabId: string; finalUrl: string; title?: string }> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.openTab(url, extraHeaders);
    const result = await this.tool<CamofoxNavigateResult>('navigate', { url });
    if (result.ok === false) {
      throw new BrowserMcpError('navigation_failed', `openTab navigate returned ok:false for ${url}`);
    }
    return {
      tabId: result.tabId,
      finalUrl: result.finalUrl ?? result.url ?? url,
      title: result.title,
    };
  }

  async closeTabExplicit(tabId: string): Promise<void> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.closeTabExplicit(tabId);
    await this.tool<{ ok: boolean }>('close_tab', { tabId });
  }

  async cookies(urls?: string[]): Promise<CookiesResult> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.cookies(urls);
    const tabId = this.requireTab();
    const args: Record<string, unknown> = { tabId };
    if (urls !== undefined && urls.length > 0) args.urls = urls;
    return this.tool<CookiesResult>('cookies', args);
  }

  async clickByHint(hint: TriggerSelectorHint): Promise<ClickByHintResult> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.clickByHint(hint);
    return this.clickByHintForTab(this.requireTab(), hint);
  }

  async setViewport(width: number, height: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.setViewport(width, height);
    const tabId = this.requireTab();
    try {
      await this.tool<{ ok: boolean; width: number; height: number }>('set_viewport', { tabId, width, height });
      return { ok: true };
    } catch (err) {
      const errMsg = String(err);
      if (/unknown tool|tool not found|not registered/i.test(errMsg)) {
        const expr = `(function(){window.resizeTo(${width},${height});window.dispatchEvent(new Event('resize'));return true;})()`;
        try {
          await this.tool<CamofoxEvaluateResult>('evaluate', { tabId, expression: expr });
          return { ok: true };
        } catch (fallbackErr) {
          return { ok: false, reason: `set_viewport unavailable + resizeTo failed: ${String(fallbackErr)}` };
        }
      }
      return { ok: false, reason: errMsg };
    }
  }

  async routeFulfill(scope: RouteFulfillScope, response: RouteFulfillResponse): Promise<UnregisterFn> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.routeFulfill(scope, response);
    const tabId = this.requireTab();
    const args: Record<string, unknown> = {
      tabId,
      method: scope.method,
      path: scope.path,
      status: response.status,
      body: response.body,
      contentType: response.contentType ?? 'application/json',
      ...(scope.bodyHash !== undefined ? { bodyHash: scope.bodyHash } : {}),
    };
    const result = await this.tool<{ fulfillId: string }>('route_fulfill', args);
    const fulfillId = result.fulfillId;
    return async () => {
      await this.tool<{ ok: boolean }>('route_fulfill_remove', { tabId, fulfillId }).catch(() => {});
    };
  }

  async setTimezoneOverride(tz: string | null): Promise<{ applied: boolean; degraded?: 'evaluate_intl' | 'unsupported' }> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.setTimezoneOverride(tz);
    const tabId = this.requireTab();
    try {
      await this.tool<{ ok: boolean }>('set_timezone', { tabId, timezone: tz ?? '' });
      return { applied: true };
    } catch (err) {
      const msg = String(err);
      if (/unknown tool|tool not found|not registered/i.test(msg)) {
        // Fallback: patch Intl.DateTimeFormat via evaluate to force TZ
        if (tz !== null) {
          const expr = `(function(tz){var orig=Intl.DateTimeFormat;Intl.DateTimeFormat=function(loc,opts){return new orig(loc,Object.assign({},opts,{timeZone:tz}));};return true;})(${JSON.stringify(tz)})`;
          await this.tool<unknown>('evaluate', { tabId, expression: expr }).catch(() => {});
          return { applied: false, degraded: 'evaluate_intl' };
        }
        return { applied: false, degraded: 'unsupported' };
      }
      throw err;
    }
  }

  async addInitScript(source: string): Promise<{ applied: boolean; degraded?: 'late_inject' | 'unsupported' }> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.addInitScript(source);
    const tabId = this.requireTab();
    try {
      await this.tool<{ ok: boolean }>('init_script', { tabId, script: source });
      return { applied: true };
    } catch (err) {
      const msg = String(err);
      if (/unknown tool|tool not found|not registered/i.test(msg)) {
        // Late-inject fallback: evaluate runs after page JS — race risk documented
        await this.tool<unknown>('evaluate', { tabId, expression: source }).catch(() => {});
        return { applied: false, degraded: 'late_inject' };
      }
      throw err;
    }
  }

  async applyNetworkFault(fault: NetworkFaultSpec): Promise<ApplyNetworkFaultResult> {
    if (this.legacyDelegate !== undefined) {
      const delegate = this.legacyDelegate;
      if (delegate.applyNetworkFault === undefined) {
        return { applied: false, reason: 'tool_not_available' };
      }
      return await delegate.applyNetworkFault(fault);
    }
    const tabId = this.requireTab();
    try {
      const result = await this.tool<{ ok: boolean; applied: boolean; reason?: string }>(
        'network_fault',
        { tabId, fault },
      );
      if (result.applied === false) {
        return { applied: false, reason: result.reason ?? 'fault_unsupported' };
      }
      return { applied: true };
    } catch (err) {
      const msg = String(err);
      if (/unknown tool|tool not found|not registered/i.test(msg)) {
        return { applied: false, reason: 'tool_not_available' };
      }
      return { applied: false, reason: msg };
    }
  }

  async clearNetworkFault(): Promise<void> {
    if (this.legacyDelegate !== undefined) {
      const delegate = this.legacyDelegate;
      if (delegate.clearNetworkFault !== undefined) {
        await delegate.clearNetworkFault();
      }
      return;
    }
    const tabId = this.requireTab();
    await this.tool<{ ok: boolean }>('clear_network_fault', { tabId }).catch(() => {});
  }

  async withTab<T>(
    url: string,
    extraHeaders: ExtraHeaders | undefined,
    fn: (scope: TabScope) => Promise<T>
  ): Promise<T> {
    if (this.legacyDelegate !== undefined) return this.legacyDelegate.withTab(url, extraHeaders, fn);
    const { tabId } = await this.openTab(url, extraHeaders);
    const scope = this.makeTabScope(tabId);
    try {
      return await fn(scope);
    } finally {
      await this.closeTabExplicit(tabId).catch(() => {});
    }
  }

  private makeTabScope(tabId: string): TabScope {
    return {
      tabId,
      navigate: (url, _extraHeaders?) =>
        this.tool<CamofoxNavigateResult>('navigate', { tabId, url }).then(r => ({
          url: r.finalUrl ?? r.url ?? url,
          title: r.title,
        })),
      click: (selector) => {
        if (typeof selector === 'string') {
          return runEvaluateClick(this.makeEvaluateScope(tabId), selector).then(() => ({ clicked: true }));
        }
        return this.resolveRef(tabId, selector).then(ref =>
          this.tool<{ tabId: string; ok: boolean }>('click', { tabId, ref }).then(() => ({ clicked: true }))
        );
      },
      clickWithObservation: (selector) => {
        if (typeof selector === 'string') {
          return runEvaluateClick(this.makeEvaluateScope(tabId), selector);
        }
        return this.resolveRef(tabId, selector)
          .then(ref => this.tool<{ tabId: string; ok: boolean }>('click', { tabId, ref }))
          .then((): EvaluateClickResult & { ok: true } => ({
            ok: true,
            accessibleNameAbsent: false,
            ariaLabelSource: null,
            tagName: 'unknown',
            role: null,
          }));
      },
      type: (selector, text) => this.resolveRef(tabId, selector).then(ref =>
        this.tool<{ tabId: string; ok: boolean }>('type', { tabId, ref, text, submit: false }).then(() => ({ typed: true }))
      ),
      scroll: (_selector, direction, distance?) =>
        this.tool<{ tabId: string; ok: boolean }>('scroll', {
          tabId,
          direction: toCamofoxScrollDirection(direction),
          amount: distance ?? 500,
        }).then(() => ({ scrolled: true })),
      snapshot: () =>
        this.tool<CamofoxSnapshotResult>('snapshot', { tabId }).then(r => ({ snapshot: r.snapshot })),
      screenshot: (outputPath?) =>
        this.tool<CamofoxScreenshotResult>('screenshot', { tabId, fullPage: false }, 'image').then(r => {
          const base64 = r.dataUrl ?? '';
          if (outputPath !== undefined) {
            if (outputPath === '') throw new Error('screenshot: outputPath is empty — caller bug?');
            const pngData = base64.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(outputPath, Buffer.from(pngData, 'base64'));
            return { path: outputPath, data: base64 };
          }
          return { path: '', data: base64 };
        }),
      evaluate: (script) =>
        this.tool<CamofoxEvaluateResult>('evaluate', { tabId, expression: script }).then(r => ({
          value: r.result ?? r.value,
        })),
      clickByHint: (hint) => this.clickByHintForTab(tabId, hint),
      applyNetworkFault: (fault) => {
        const self = this;
        return (async () => {
          try {
            const result = await self.tool<{ ok: boolean; applied: boolean; reason?: string }>(
              'network_fault',
              { tabId, fault },
            );
            if (result.applied === false) {
              return { applied: false as const, reason: result.reason ?? 'fault_unsupported' };
            }
            return { applied: true as const };
          } catch (err) {
            const msg = String(err);
            if (/unknown tool|tool not found|not registered/i.test(msg)) {
              return { applied: false as const, reason: 'tool_not_available' as const };
            }
            return { applied: false as const, reason: msg };
          }
        })();
      },
      clearNetworkFault: () =>
        this.tool<{ ok: boolean }>('clear_network_fault', { tabId }).then(() => undefined).catch(() => undefined),
    };
  }

  private async clickByHintForTab(tabId: string, hint: TriggerSelectorHint): Promise<ClickByHintResult> {
    if (hint.testId !== undefined && hint.testId !== '') {
      if (await this.evaluateClickByCss(tabId, `[data-testid="${CamofoxBrowserMcpAdapter.escapeAttr(hint.testId)}"]`)) {
        return { clicked: true, matchedBy: 'testId' };
      }
    }
    if (hint.ariaLabel !== undefined && hint.ariaLabel !== '') {
      if (await this.evaluateClickByCss(tabId, `[aria-label="${CamofoxBrowserMcpAdapter.escapeAttr(hint.ariaLabel)}"]`)) {
        return { clicked: true, matchedBy: 'ariaLabel' };
      }
    }
    if (hint.text !== undefined && hint.text !== '') {
      if (await this.evaluateClickByText(tabId, hint.text)) {
        return { clicked: true, matchedBy: 'text' };
      }
    }

    const hasPopulatedField =
      (hint.testId !== undefined && hint.testId !== '') ||
      (hint.ariaLabel !== undefined && hint.ariaLabel !== '') ||
      (hint.text !== undefined && hint.text !== '');
    return { clicked: false, reason: hasPopulatedField ? 'not_found' : 'no_hint_fields' };
  }
}

// ---- CamofoxBrowserHttpAdapter — deprecated legacy (hand-rolled JSON-RPC) ----

/**
 * @deprecated Use CamofoxBrowserMcpAdapter (SDK Client) instead.
 * This class was previously named CamofoxBrowserMcpAdapter. Renamed in v0.49 to
 * CamofoxBrowserHttpAdapter to reflect what it actually does: hand-rolled JSON-RPC
 * over fetch, targeting the camofox-mcp HTTP server at port 3104.
 *
 * Will be removed in v0.50. Select via browserTransport:'http-legacy' in config,
 * or construct directly for testing. Each construction emits a console.warn.
 */
export class CamofoxBrowserHttpAdapter implements BrowserMcpAdapter {
  private readonly baseUrl: string;
  private currentTabId?: string;
  private static deprecationWarned = false;

  constructor(baseUrl: string = 'http://127.0.0.1:3100') {
    // Emit deprecation warning once per process (not per instance)
    if (!CamofoxBrowserHttpAdapter.deprecationWarned) {
      CamofoxBrowserHttpAdapter.deprecationWarned = true;
      console.warn(
        '[bughunter] CamofoxBrowserHttpAdapter (browserTransport: http-legacy) is deprecated; ' +
        'switch to mcp-http (SDK Client) before v0.50.'
      );
    }
    this.baseUrl = baseUrl.replace(/\/mcp\/?$/, '').replace(/\/$/, '');
  }

  private async mcpCall<T>(
    tool: string,
    args: Record<string, unknown>,
    expect: 'json' | 'image' = 'json'
  ): Promise<T> {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    };
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new BrowserMcpError('transport', `camofox fetch failed: ${String(err)}`, undefined, err);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new BrowserMcpError('transport', `camofox HTTP ${res.status}: ${text}`);
    }

    const contentType = res.headers.get('content-type') ?? '';
    const envelope = await parseEnvelope(res, contentType);

    if (envelope.error !== undefined) {
      const msg = String(envelope.error.message ?? envelope.error);
      throw new BrowserMcpError(classifyRpcError(msg, tool), `camofox ${tool} error: ${msg}`, undefined);
    }

    if (envelope.result?.isError === true) {
      const msg = envelope.result.content?.[0]?.text ?? 'Unknown MCP tool error';
      throw new BrowserMcpError(classifyRpcError(msg, tool), `camofox ${tool} error: ${msg}`, undefined);
    }

    if (expect === 'image') {
      return parseImageContent(envelope) as T;
    }
    return parseTextContent(envelope, tool) as T;
  }

  private requireTab(): string {
    if (this.currentTabId === undefined) {
      throw new BrowserMcpError('no_tab', 'Adapter has no active tab; call navigate(url) first');
    }
    return this.currentTabId;
  }

  private async resolveRef(tabId: string, selector: string | StructuredSelector): Promise<string> {
    const raw = await this.mcpCall<CamofoxSnapshotResult>('snapshot', { tabId });
    const nodes = parseSnapshot(raw.snapshot);
    if (nodes.length === 0) {
      throw new BrowserMcpError('snapshot_failed', 'Snapshot parsed 0 elements; tab may have crashed');
    }
    const ref = resolveSelectorInSnapshot(selector, nodes);
    if (ref !== null) return ref;

    if (typeof selector !== 'string') {
      throw new BrowserMcpError('element_not_found', `No matching ref in snapshot`, String(selector));
    }
    return this.resolveViaEvaluate(tabId, selector, nodes);
  }

  private async resolveViaEvaluate(tabId: string, selector: string, _nodes: SnapshotNode[]): Promise<string> {
    const safeSelector = selector.replace(/'/g, "\\'");
    const expr = `document.querySelector('${safeSelector}')?.outerHTML?.slice(0, 200) ?? null`;
    let evalResult: CamofoxEvaluateResult;
    try {
      evalResult = await this.mcpCall<CamofoxEvaluateResult>('evaluate', { tabId, expression: expr });
    } catch {
      throw new BrowserMcpError('element_not_found', `No matching ref in snapshot or DOM`, selector);
    }

    const html = String(evalResult.result ?? evalResult.value ?? '');
    if (html === '' || html === 'null') {
      throw new BrowserMcpError('element_not_found', `No matching ref in snapshot or DOM`, selector);
    }

    const fresh = await this.mcpCall<CamofoxSnapshotResult>('snapshot', { tabId });
    const freshNodes = parseSnapshot(fresh.snapshot);
    const tagMatch = /^\.?(\w+)/.exec(selector);
    const tag = tagMatch?.[1] ?? 'div';
    const ref = resolveByHtml(html, tag, freshNodes);
    if (ref === null) {
      throw new BrowserMcpError(
        'element_not_found',
        `Element exists in DOM but has no accessible name in snapshot`,
        selector
      );
    }
    return ref;
  }

  private makeEvaluateScope(tabId: string) {
    return {
      evaluate: (script: string) =>
        this.mcpCall<CamofoxEvaluateResult>('evaluate', { tabId, expression: script }).then(r => ({
          value: r.result ?? r.value,
        })),
    };
  }

  private static escapeAttr(value: string): string {
    return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  private async evaluateClickByCss(tabId: string, css: string): Promise<boolean> {
    const expr = `(function(){var el=document.querySelector(${JSON.stringify(css)});if(!el)return false;var r=el.getBoundingClientRect();if(el.offsetParent===null&&(r.width===0||r.height===0))return false;el.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0}));return true;})()`;
    try {
      const result = await this.mcpCall<CamofoxEvaluateResult>('evaluate', { tabId, expression: expr });
      return (result.result ?? result.value) === true;
    } catch {
      return false;
    }
  }

  private async evaluateClickByText(tabId: string, text: string): Promise<boolean> {
    const expr = `(function(){var text=${JSON.stringify(text.toLowerCase())};var sel='button, a, [role="button"], [role="tab"], [role="link"]';var els=Array.from(document.querySelectorAll(sel));function visible(el){var r=el.getBoundingClientRect();return el.offsetParent!==null||(r.width>0&&r.height>0);}var candidates=els.filter(visible);var target=candidates.find(function(el){return(el.textContent||'').trim().toLowerCase()===text;})||candidates.find(function(el){return(el.textContent||'').toLowerCase().includes(text);});if(!target)return false;target.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,button:0}));return true;})()`;
    try {
      const result = await this.mcpCall<CamofoxEvaluateResult>('evaluate', { tabId, expression: expr });
      return (result.result ?? result.value) === true;
    } catch {
      return false;
    }
  }

  async navigate(url: string, _extraHeaders?: ExtraHeaders): Promise<NavigateResult> {
    const args: Record<string, unknown> = this.currentTabId !== undefined
      ? { tabId: this.currentTabId, url }
      : { url };
    const result = await this.mcpCall<CamofoxNavigateResult>('navigate', args);
    this.currentTabId = result.tabId;
    if (result.ok === false) {
      throw new BrowserMcpError('navigation_failed', `navigate returned ok:false for ${url}`);
    }
    return { url: result.finalUrl ?? result.url ?? url, title: result.title };
  }

  async click(selector: string | StructuredSelector): Promise<ClickResult> {
    const tabId = this.requireTab();
    if (typeof selector === 'string') {
      await runEvaluateClick(this.makeEvaluateScope(tabId), selector);
      return { clicked: true };
    }
    try {
      const ref = await this.resolveRef(tabId, selector);
      await this.mcpCall<{ tabId: string; ok: boolean }>('click', { tabId, ref });
      return { clicked: true };
    } catch (err) {
      if (err instanceof BrowserMcpError && err.kind === 'element_not_found') {
        const ref = await this.resolveRef(tabId, selector);
        await this.mcpCall<{ tabId: string; ok: boolean }>('click', { tabId, ref });
        return { clicked: true };
      }
      throw err;
    }
  }

  async type(selector: string | StructuredSelector, text: string): Promise<TypeResult> {
    const tabId = this.requireTab();
    try {
      const ref = await this.resolveRef(tabId, selector);
      await this.mcpCall<{ tabId: string; ok: boolean }>('type', { tabId, ref, text, submit: false });
      return { typed: true };
    } catch (err) {
      if (err instanceof BrowserMcpError && err.kind === 'element_not_found') {
        const ref = await this.resolveRef(tabId, selector);
        await this.mcpCall<{ tabId: string; ok: boolean }>('type', { tabId, ref, text, submit: false });
        return { typed: true };
      }
      throw err;
    }
  }

  async scroll(_selector: string, direction: 'up' | 'down', distance?: number): Promise<ScrollResult> {
    const tabId = this.requireTab();
    await this.mcpCall<{ tabId: string; ok: boolean }>('scroll', {
      tabId,
      direction: toCamofoxScrollDirection(direction),
      amount: distance ?? 500,
    });
    return { scrolled: true };
  }

  async snapshot(): Promise<SnapshotResult> {
    const tabId = this.requireTab();
    const result = await this.mcpCall<CamofoxSnapshotResult>('snapshot', { tabId });
    return { snapshot: result.snapshot };
  }

  async screenshot(outputPath?: string): Promise<ScreenshotResult> {
    const tabId = this.requireTab();
    const result = await this.mcpCall<CamofoxScreenshotResult>('screenshot', { tabId, fullPage: false }, 'image');
    const base64 = result.dataUrl ?? '';
    if (outputPath !== undefined) {
      if (outputPath === '') throw new Error('screenshot: outputPath is empty — caller bug?');
      const pngData = base64.replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(outputPath, Buffer.from(pngData, 'base64'));
      return { path: outputPath, data: base64 };
    }
    return { path: '', data: base64 };
  }

  async evaluate(script: string): Promise<EvaluateResult> {
    const tabId = this.requireTab();
    const result = await this.mcpCall<CamofoxEvaluateResult>('evaluate', { tabId, expression: script });
    return { value: result.result ?? result.value };
  }

  async listTabs(): Promise<ListTabsResult> {
    const result = await this.mcpCall<CamofoxListTabsResult>('list_tabs', {});
    const tabs = result.tabs.map(t => ({
      id: t.tabId ?? t.id ?? '',
      url: t.url,
      title: t.title,
    }));
    return { tabs };
  }

  async closeTab(tabId: string): Promise<CloseTabResult> {
    await this.mcpCall<{ ok: boolean }>('close_tab', { tabId });
    if (tabId === this.currentTabId) this.currentTabId = undefined;
    return { closed: true };
  }

  async openTab(url: string, _extraHeaders?: ExtraHeaders): Promise<{ tabId: string; finalUrl: string; title?: string }> {
    const result = await this.mcpCall<CamofoxNavigateResult>('navigate', { url });
    if (result.ok === false) {
      throw new BrowserMcpError('navigation_failed', `openTab navigate returned ok:false for ${url}`);
    }
    return {
      tabId: result.tabId,
      finalUrl: result.finalUrl ?? result.url ?? url,
      title: result.title,
    };
  }

  async closeTabExplicit(tabId: string): Promise<void> {
    await this.mcpCall<{ ok: boolean }>('close_tab', { tabId });
  }

  async cookies(urls?: string[]): Promise<CookiesResult> {
    const tabId = this.requireTab();
    const args: Record<string, unknown> = { tabId };
    if (urls !== undefined && urls.length > 0) args.urls = urls;
    return this.mcpCall<CookiesResult>('cookies', args);
  }

  async clickByHint(hint: TriggerSelectorHint): Promise<ClickByHintResult> {
    return this.clickByHintForTab(this.requireTab(), hint);
  }

  async setViewport(width: number, height: number): Promise<{ ok: true } | { ok: false; reason: string }> {
    const tabId = this.requireTab();
    try {
      await this.mcpCall<{ ok: boolean; width: number; height: number }>('set_viewport', { tabId, width, height });
      return { ok: true };
    } catch (err) {
      const errMsg = String(err);
      if (/unknown tool|tool not found|not registered/i.test(errMsg)) {
        const expr = `(function(){window.resizeTo(${width},${height});window.dispatchEvent(new Event('resize'));return true;})()`;
        try {
          await this.mcpCall<CamofoxEvaluateResult>('evaluate', { tabId, expression: expr });
          return { ok: true };
        } catch (fallbackErr) {
          return { ok: false, reason: `set_viewport unavailable + resizeTo failed: ${String(fallbackErr)}` };
        }
      }
      return { ok: false, reason: errMsg };
    }
  }

  async routeFulfill(scope: RouteFulfillScope, response: RouteFulfillResponse): Promise<UnregisterFn> {
    const tabId = this.requireTab();
    const args: Record<string, unknown> = {
      tabId,
      method: scope.method,
      path: scope.path,
      status: response.status,
      body: response.body,
      contentType: response.contentType ?? 'application/json',
      ...(scope.bodyHash !== undefined ? { bodyHash: scope.bodyHash } : {}),
    };
    const result = await this.mcpCall<{ fulfillId: string }>('route_fulfill', args);
    const fulfillId = result.fulfillId;
    return async () => {
      await this.mcpCall<{ ok: boolean }>('route_fulfill_remove', { tabId, fulfillId }).catch(() => {});
    };
  }

  async setTimezoneOverride(tz: string | null): Promise<{ applied: boolean; degraded?: 'evaluate_intl' | 'unsupported' }> {
    const tabId = this.requireTab();
    try {
      await this.mcpCall<{ ok: boolean }>('set_timezone', { tabId, timezone: tz ?? '' });
      return { applied: true };
    } catch (err) {
      const msg = String(err);
      if (/unknown tool|tool not found|not registered/i.test(msg)) {
        if (tz !== null) {
          const expr = `(function(tz){var orig=Intl.DateTimeFormat;Intl.DateTimeFormat=function(loc,opts){return new orig(loc,Object.assign({},opts,{timeZone:tz}));};return true;})(${JSON.stringify(tz)})`;
          await this.mcpCall<unknown>('evaluate', { tabId, expression: expr }).catch(() => {});
          return { applied: false, degraded: 'evaluate_intl' };
        }
        return { applied: false, degraded: 'unsupported' };
      }
      throw err;
    }
  }

  async addInitScript(source: string): Promise<{ applied: boolean; degraded?: 'late_inject' | 'unsupported' }> {
    const tabId = this.requireTab();
    try {
      await this.mcpCall<{ ok: boolean }>('init_script', { tabId, script: source });
      return { applied: true };
    } catch (err) {
      const msg = String(err);
      if (/unknown tool|tool not found|not registered/i.test(msg)) {
        await this.mcpCall<unknown>('evaluate', { tabId, expression: source }).catch(() => {});
        return { applied: false, degraded: 'late_inject' };
      }
      throw err;
    }
  }

  async withTab<T>(
    url: string,
    extraHeaders: ExtraHeaders | undefined,
    fn: (scope: TabScope) => Promise<T>
  ): Promise<T> {
    const { tabId } = await this.openTab(url, extraHeaders);
    const scope = this.makeTabScope(tabId);
    try {
      return await fn(scope);
    } finally {
      await this.closeTabExplicit(tabId).catch(() => {});
    }
  }

  private makeTabScope(tabId: string): TabScope {
    return {
      tabId,
      navigate: (url, _extraHeaders?) =>
        this.mcpCall<CamofoxNavigateResult>('navigate', { tabId, url }).then(r => ({
          url: r.finalUrl ?? r.url ?? url,
          title: r.title,
        })),
      click: (selector) => {
        if (typeof selector === 'string') {
          return runEvaluateClick(this.makeEvaluateScope(tabId), selector).then(() => ({ clicked: true }));
        }
        return this.resolveRef(tabId, selector).then(ref =>
          this.mcpCall<{ tabId: string; ok: boolean }>('click', { tabId, ref }).then(() => ({ clicked: true }))
        );
      },
      clickWithObservation: (selector) => {
        if (typeof selector === 'string') {
          return runEvaluateClick(this.makeEvaluateScope(tabId), selector);
        }
        return this.resolveRef(tabId, selector)
          .then(ref => this.mcpCall<{ tabId: string; ok: boolean }>('click', { tabId, ref }))
          .then((): EvaluateClickResult & { ok: true } => ({
            ok: true,
            accessibleNameAbsent: false,
            ariaLabelSource: null,
            tagName: 'unknown',
            role: null,
          }));
      },
      type: (selector, text) => this.resolveRef(tabId, selector).then(ref =>
        this.mcpCall<{ tabId: string; ok: boolean }>('type', { tabId, ref, text, submit: false }).then(() => ({ typed: true }))
      ),
      scroll: (_selector, direction, distance?) =>
        this.mcpCall<{ tabId: string; ok: boolean }>('scroll', {
          tabId,
          direction: toCamofoxScrollDirection(direction),
          amount: distance ?? 500,
        }).then(() => ({ scrolled: true })),
      snapshot: () =>
        this.mcpCall<CamofoxSnapshotResult>('snapshot', { tabId }).then(r => ({ snapshot: r.snapshot })),
      screenshot: (outputPath?) =>
        this.mcpCall<CamofoxScreenshotResult>('screenshot', { tabId, fullPage: false }, 'image').then(r => {
          const base64 = r.dataUrl ?? '';
          if (outputPath !== undefined) {
            if (outputPath === '') throw new Error('screenshot: outputPath is empty — caller bug?');
            const pngData = base64.replace(/^data:image\/\w+;base64,/, '');
            fs.writeFileSync(outputPath, Buffer.from(pngData, 'base64'));
            return { path: outputPath, data: base64 };
          }
          return { path: '', data: base64 };
        }),
      evaluate: (script) =>
        this.mcpCall<CamofoxEvaluateResult>('evaluate', { tabId, expression: script }).then(r => ({
          value: r.result ?? r.value,
        })),
      clickByHint: (hint) => this.clickByHintForTab(tabId, hint),
      // v0.20: network fault methods — not available in the legacy adapter
      applyNetworkFault: (_fault) => Promise.resolve({ applied: false as const, reason: 'tool_not_available' as const }),
      clearNetworkFault: () => Promise.resolve(),
    };
  }

  private async clickByHintForTab(tabId: string, hint: TriggerSelectorHint): Promise<ClickByHintResult> {
    if (hint.testId !== undefined && hint.testId !== '') {
      if (await this.evaluateClickByCss(tabId, `[data-testid="${CamofoxBrowserHttpAdapter.escapeAttr(hint.testId)}"]`)) {
        return { clicked: true, matchedBy: 'testId' };
      }
    }
    if (hint.ariaLabel !== undefined && hint.ariaLabel !== '') {
      if (await this.evaluateClickByCss(tabId, `[aria-label="${CamofoxBrowserHttpAdapter.escapeAttr(hint.ariaLabel)}"]`)) {
        return { clicked: true, matchedBy: 'ariaLabel' };
      }
    }
    if (hint.text !== undefined && hint.text !== '') {
      if (await this.evaluateClickByText(tabId, hint.text)) {
        return { clicked: true, matchedBy: 'text' };
      }
    }

    const hasPopulatedField =
      (hint.testId !== undefined && hint.testId !== '') ||
      (hint.ariaLabel !== undefined && hint.ariaLabel !== '') ||
      (hint.text !== undefined && hint.text !== '');
    return { clicked: false, reason: hasPopulatedField ? 'not_found' : 'no_hint_fields' };
  }

  applyNetworkFault(_fault: NetworkFaultSpec): Promise<ApplyNetworkFaultResult> {
    return Promise.resolve({ applied: false as const, reason: 'tool_not_available' as const });
  }

  clearNetworkFault(): Promise<void> {
    return Promise.resolve();
  }
}

// ---- Factory ----

/**
 * Create the correct BrowserMcpAdapter for the resolved config.
 * Returns undefined when no browser transport is configured.
 *
 * Resolution logic:
 * - 'mcp-http' (default): SDK Client + StreamableHTTPClientTransport. Requires browserMcpUrl.
 * - 'mcp-stdio': SDK Client + StdioClientTransport. Requires browserMcpStdio.command.
 *   Can operate without browserMcpUrl (subprocess is self-contained).
 * - 'http-legacy': deprecated hand-rolled fetch adapter. Requires browserMcpUrl.
 *
 * Conservative defaults for open questions (per spec §15):
 * Q1: Legacy class is exported — users can migrate by name.
 * Q2: SDK Client used directly — dispatcher (tool<T>) is the abstraction.
 * Q3: Factory co-located in browser-mcp.ts for v0.49.
 * Q4: network_fault etc. deferred; callers use the tool<T> escape via the MCP adapter.
 * Q5: bughunter doctor prints transport config info only (no round-trip in v0.49).
 * Q6: No per-call timeout in v0.49; SDK default applies (~30s). Add browserMcpRequestTimeoutMs in v0.50.
 * Q7: mcp-stdio errors surface immediately; auto-restart is policy for the runner, not the adapter.
 */
export function makeBrowserAdapter(config: BugHunterConfig): BrowserMcpAdapter | undefined {
  const transport = config.browserTransport ?? 'mcp-http';
  const authKey = config.browserMcpAuthKey ?? process.env['CAMOFOX_MCP_KEY'];

  if (transport === 'mcp-stdio') {
    if (config.browserMcpStdio === undefined) {
      throw new Error('browserTransport: mcp-stdio requires browserMcpStdio.command to be set in config');
    }
    return new CamofoxBrowserMcpAdapter({
      mode: 'stdio',
      command: config.browserMcpStdio.command,
      args: config.browserMcpStdio.args,
      authKey,
    });
  }

  if (transport === 'http-legacy') {
    if (config.browserMcpUrl === undefined) return undefined;
    return new CamofoxBrowserHttpAdapter(config.browserMcpUrl);
  }

  // Default: mcp-http
  if (config.browserMcpUrl === undefined) return undefined;
  return new CamofoxBrowserMcpAdapter({
    mode: 'http',
    url: config.browserMcpUrl,
    authKey,
  });
}

// ---- Legacy transport helpers (used by CamofoxBrowserHttpAdapter only) ----

type McpRpcEnvelope = {
  result?: {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  };
  error?: { message?: string; code?: unknown };
};

async function parseEnvelope(res: Response, contentType: string): Promise<McpRpcEnvelope> {
  if (contentType.includes('text/event-stream')) {
    const text = await res.text();
    const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
    if (dataLines.length === 0) {
      throw new BrowserMcpError('transport', 'Empty SSE stream from camofox');
    }
    const last = dataLines[dataLines.length - 1].slice(6);
    return JSON.parse(last) as McpRpcEnvelope;
  }
  return res.json() as Promise<McpRpcEnvelope>;
}

function parseTextContent(envelope: McpRpcEnvelope, tool: string): unknown {
  const content = envelope.result?.content?.[0];
  if (content === undefined) {
    throw new BrowserMcpError('transport', `No content in camofox response for ${tool}`);
  }
  if (content.type === 'image') {
    return { dataUrl: `data:${content.mimeType ?? 'image/png'};base64,${content.data ?? ''}` };
  }
  const text = content.text;
  if (text === undefined || text === '') {
    throw new BrowserMcpError('transport', `Empty text content in camofox response for ${tool}`);
  }
  return JSON.parse(text);
}

function parseImageContent(envelope: McpRpcEnvelope): { dataUrl: string } {
  const content = envelope.result?.content?.[0];
  if (content?.type === 'image') {
    return { dataUrl: `data:${content.mimeType ?? 'image/png'};base64,${content.data ?? ''}` };
  }
  const text = content?.text;
  if (text !== undefined && text !== '') {
    const parsed = JSON.parse(text) as { dataUrl?: string };
    return { dataUrl: parsed.dataUrl ?? '' };
  }
  throw new BrowserMcpError('screenshot_failed', 'No image content in camofox screenshot response');
}
