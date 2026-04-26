// Adapter wrapping camofox MCP tools.
// At runtime this calls the real camofox MCP; in tests the adapter is mocked.

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
  click(selector: string): Promise<ClickResult>;
  type(selector: string, text: string): Promise<TypeResult>;
  scroll(selector: string, direction: 'up' | 'down', distance?: number): Promise<ScrollResult>;
  snapshot(): Promise<SnapshotResult>;
  screenshot(outputPath?: string): Promise<ScreenshotResult>;
  evaluate(script: string): Promise<EvaluateResult>;
  listTabs(): Promise<ListTabsResult>;
  closeTab(tabId: string): Promise<CloseTabResult>;
}

// Calls the real camofox MCP tools via its MCP endpoint.
export class CamofoxBrowserMcpAdapter implements BrowserMcpAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string = 'http://127.0.0.1:3100/mcp') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async mcpCall<T>(tool: string, args: unknown): Promise<T> {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    };
    const res = await fetch(`${this.baseUrl}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`camofox MCP HTTP ${res.status}: ${await res.text()}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const text = await res.text();
      const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
      if (dataLines.length === 0) throw new Error('Empty SSE stream from camofox');
      const last = dataLines[dataLines.length - 1].slice(6);
      const parsed = JSON.parse(last) as { result?: { content?: Array<{ text?: string }> }; error?: unknown };
      if (parsed.error) throw new Error(`camofox error: ${JSON.stringify(parsed.error)}`);
      const content = parsed.result?.content?.[0]?.text;
      if (!content) throw new Error('No content in camofox response');
      return JSON.parse(content) as T;
    }
    const json = await res.json() as { result?: { content?: Array<{ text?: string }> }; error?: unknown };
    if (json.error) throw new Error(`camofox error: ${JSON.stringify(json.error)}`);
    const content = json.result?.content?.[0]?.text;
    if (!content) throw new Error('No content in camofox response');
    return JSON.parse(content) as T;
  }

  navigate(url: string, extraHeaders?: ExtraHeaders): Promise<NavigateResult> {
    return this.mcpCall<NavigateResult>('mcp__camofox__navigate', { url, extraHeaders });
  }

  click(selector: string): Promise<ClickResult> {
    return this.mcpCall<ClickResult>('mcp__camofox__click', { selector });
  }

  type(selector: string, text: string): Promise<TypeResult> {
    return this.mcpCall<TypeResult>('mcp__camofox__type', { selector, text });
  }

  scroll(selector: string, direction: 'up' | 'down', distance?: number): Promise<ScrollResult> {
    return this.mcpCall<ScrollResult>('mcp__camofox__scroll', { selector, direction, distance });
  }

  snapshot(): Promise<SnapshotResult> {
    return this.mcpCall<SnapshotResult>('mcp__camofox__snapshot', {});
  }

  screenshot(outputPath?: string): Promise<ScreenshotResult> {
    return this.mcpCall<ScreenshotResult>('mcp__camofox__screenshot', { outputPath });
  }

  evaluate(script: string): Promise<EvaluateResult> {
    return this.mcpCall<EvaluateResult>('mcp__camofox__evaluate', { script });
  }

  listTabs(): Promise<ListTabsResult> {
    return this.mcpCall<ListTabsResult>('mcp__camofox__list_tabs', {});
  }

  closeTab(tabId: string): Promise<CloseTabResult> {
    return this.mcpCall<CloseTabResult>('mcp__camofox__close_tab', { tabId });
  }
}
