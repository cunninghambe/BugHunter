/**
 * Adapter wrapping the camofox HTTP MCP server (port 3104 by default).
 *
 * Public interface stays selector-shaped so callers (dom-walker.ts, replay.ts,
 * phases/execute.ts) need no changes. This class internalises:
 *   - Tab tracking (single tab per session)
 *   - Snapshot → ref resolution (see browser-mcp-snapshot.ts)
 *   - JSON-RPC transport + envelope parsing
 *   - Error mapping to BrowserMcpError
 *
 * URL convention: `baseUrl` is the base URL without `/mcp` (e.g.
 * "http://127.0.0.1:3104"). The adapter appends `/mcp` internally.
 * A trailing `/mcp` (with optional slash) is stripped for backward-compat.
 *
 * Limitation: `navigate`'s `extraHeaders` parameter is accepted but silently
 * dropped — camofox v0.1 has no per-tab header passthrough.
 */

import * as fs from 'node:fs';
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
import type { StructuredSelector } from './browser-mcp-snapshot.js';

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
}

// Raw camofox result shapes.
// Note: camofox v0.1 navigate returns {tabId, url} — the SPEC.md frozen surface
// lists {tabId, ok, finalUrl, title?} but the running daemon returns {tabId, url}.
// We accept both shapes: ok is optional (undefined = success), url/finalUrl interchangeable.
type CamofoxNavigateResult = { tabId: string; ok?: boolean; finalUrl?: string; url?: string; title?: string };
type CamofoxSnapshotResult = { tabId: string; snapshot: string };
type CamofoxScreenshotResult = { tabId: string; dataUrl?: string };
type CamofoxEvaluateResult = { tabId: string; result?: unknown; value?: unknown };
type CamofoxListTabsResult = { tabs: Array<{ tabId?: string; id?: string; url: string; title: string }> };

type McpRpcEnvelope = {
  result?: {
    content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
    isError?: boolean;
  };
  error?: { message?: string; code?: unknown };
};

export class CamofoxBrowserMcpAdapter implements BrowserMcpAdapter {
  private readonly baseUrl: string;
  private currentTabId?: string;

  constructor(baseUrl: string = 'http://127.0.0.1:3100') {
    // Strip one trailing /mcp (with optional slash) for backward-compat, then
    // strip any remaining trailing slash — the adapter appends /mcp internally.
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

    if (envelope.error) {
      const msg = String(envelope.error.message ?? envelope.error);
      throw new BrowserMcpError(classifyRpcError(msg, tool), `camofox ${tool} error: ${msg}`, undefined);
    }

    // MCP tool-level errors use result.isError = true with text content
    if (envelope.result?.isError) {
      const msg = envelope.result.content?.[0]?.text ?? 'Unknown MCP tool error';
      throw new BrowserMcpError(classifyRpcError(msg, tool), `camofox ${tool} error: ${msg}`, undefined);
    }

    if (expect === 'image') {
      return parseImageContent(envelope) as T;
    }
    return parseTextContent(envelope, tool) as T;
  }

  private requireTab(): string {
    if (!this.currentTabId) {
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

    // Evaluate fallback for .class, :nth-of-type, #id, unknown selectors
    if (typeof selector !== 'string') {
      throw new BrowserMcpError('element_not_found', `No matching ref in snapshot`, String(selector));
    }
    return this.resolveViaEvaluate(tabId, selector, nodes);
  }

  private async resolveViaEvaluate(tabId: string, selector: string, nodes: import('./browser-mcp-snapshot.js').SnapshotNode[]): Promise<string> {
    const safeSelector = selector.replace(/'/g, "\\'");
    const expr = `document.querySelector('${safeSelector}')?.outerHTML?.slice(0, 200) ?? null`;
    let evalResult: CamofoxEvaluateResult;
    try {
      evalResult = await this.mcpCall<CamofoxEvaluateResult>('evaluate', { tabId, expression: expr });
    } catch {
      throw new BrowserMcpError('element_not_found', `No matching ref in snapshot or DOM`, selector);
    }

    const html = String(evalResult.result ?? evalResult.value ?? '');
    if (!html || html === 'null') {
      throw new BrowserMcpError('element_not_found', `No matching ref in snapshot or DOM`, selector);
    }

    // Re-snapshot and walk
    const fresh = await this.mcpCall<CamofoxSnapshotResult>('snapshot', { tabId });
    const freshNodes = parseSnapshot(fresh.snapshot);
    const tagMatch = /^\.?(\w+)/.exec(selector);
    const tag = tagMatch?.[1] ?? 'div';
    const ref = resolveByHtml(html, tag, freshNodes);
    if (!ref) {
      throw new BrowserMcpError(
        'element_not_found',
        `Element exists in DOM but has no accessible name in snapshot`,
        selector
      );
    }
    return ref;
  }

  // ---- Public interface ----

  async navigate(url: string, _extraHeaders?: ExtraHeaders): Promise<NavigateResult> {
    // extraHeaders silently dropped — camofox v0.1 has no per-tab header support
    const args: Record<string, unknown> = this.currentTabId
      ? { tabId: this.currentTabId, url }
      : { url };
    const result = await this.mcpCall<CamofoxNavigateResult>('navigate', args);
    this.currentTabId = result.tabId;
    // Only throw if ok is explicitly false; undefined means the field is absent (real camofox shape)
    if (result.ok === false) {
      throw new BrowserMcpError('navigation_failed', `navigate returned ok:false for ${url}`);
    }
    return { url: result.finalUrl ?? result.url ?? url, title: result.title };
  }

  /**
   * Click an element. Accepts a CSS selector string or structured {role, name?, nth?}.
   * Takes one fresh snapshot per call. Retries once on element_not_found (dynamic DOM).
   * Note: ambiguous selectors resolve to the first match in document order.
   */
  async click(selector: string | StructuredSelector): Promise<ClickResult> {
    const tabId = this.requireTab();
    try {
      const ref = await this.resolveRef(tabId, selector);
      await this.mcpCall<{ tabId: string; ok: boolean }>('click', { tabId, ref });
      return { clicked: true };
    } catch (err) {
      if (err instanceof BrowserMcpError && err.kind === 'element_not_found') {
        // Single retry after re-snapshot (dynamic-render race)
        const ref = await this.resolveRef(tabId, selector);
        await this.mcpCall<{ tabId: string; ok: boolean }>('click', { tabId, ref });
        return { clicked: true };
      }
      throw err;
    }
  }

  /**
   * Type into an element. Accepts a CSS selector string or structured {role, name?, nth?}.
   * Takes one fresh snapshot per call. Retries once on element_not_found.
   */
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

  /**
   * Scroll the page. The `selector` parameter is accepted for API compatibility
   * but ignored — camofox is whole-page scroll only.
   */
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

  /**
   * Take a screenshot. If `outputPath` is provided, writes the base64 PNG to disk.
   * Returns `{path: outputPath, data: base64}` or `{path: '', data: base64}`.
   */
  async screenshot(outputPath?: string): Promise<ScreenshotResult> {
    const tabId = this.requireTab();
    const result = await this.mcpCall<CamofoxScreenshotResult>('screenshot', { tabId, fullPage: false }, 'image');
    const base64 = result.dataUrl ?? '';
    if (outputPath) {
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
    const tabs = (result.tabs ?? []).map(t => ({
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
}

// ---- Transport helpers (pure) ----

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
  if (!content) {
    throw new BrowserMcpError('transport', `No content in camofox response for ${tool}`);
  }
  if (content.type === 'image') {
    // Shouldn't happen on a json-expecting call, but guard
    return { dataUrl: `data:${content.mimeType ?? 'image/png'};base64,${content.data ?? ''}` };
  }
  const text = content.text;
  if (!text) {
    throw new BrowserMcpError('transport', `Empty text content in camofox response for ${tool}`);
  }
  return JSON.parse(text);
}

function parseImageContent(envelope: McpRpcEnvelope): { dataUrl: string } {
  const content = envelope.result?.content?.[0];
  if (content?.type === 'image') {
    return { dataUrl: `data:${content.mimeType ?? 'image/png'};base64,${content.data ?? ''}` };
  }
  // Fallback: if text content, treat as JSON with dataUrl inside
  const text = content?.text;
  if (text) {
    const parsed = JSON.parse(text) as { dataUrl?: string };
    return { dataUrl: parsed.dataUrl ?? '' };
  }
  throw new BrowserMcpError('screenshot_failed', 'No image content in camofox screenshot response');
}
