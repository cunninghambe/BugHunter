// Adapter for SurfaceMCP § 4.1 tool surface.
// All negative-test palette calls must pass noAutoRelogin: true (§ 3.4.3).

import type { ToolMeta, JsonSchema } from '../types.js';

export type SurfaceListToolsResult = {
  revision: number;
  tools: ToolMeta[];
};

export type SurfaceCallInput = {
  name?: string;
  toolId?: string;
  role: string;
  input: unknown;
  timeoutMs?: number;
  allowExternal?: boolean;
  noAutoRelogin?: boolean;
  pinRevision?: number;
};

export type SurfaceCallResult = {
  ok: boolean;
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
  bodyTruncated?: boolean;
  error?: { code: string; message: string };
  durationMs: number;
  revisionAtCall: number;
};

export type SurfaceProbeResult = {
  recoveredSchema?: JsonSchema;
  confidence: 'inferred' | 'unknown';
  rawError?: unknown;
};

export type SurfaceSampleInputsResult = {
  samples: Array<{ source: string; input: unknown }>;
};

export type SurfaceLoginStatusResult = {
  authenticated: boolean;
  cachedAt?: string;
  cookieDomain?: string;
  lastRefreshAt?: string;
  refreshCount: number;
};

export type SurfaceRoutesForPageResult = {
  tools: Array<{ toolId: string; name: string; sourceLocation: string }>;
};

export type ToolDescription = ToolMeta & { rawHandlerSnippet?: string };

export interface SurfaceMcpAdapter {
  surface_list_tools(filter?: {
    method?: string;
    sideEffect?: string;
    pathPrefix?: string;
    confidence?: string;
  }): Promise<SurfaceListToolsResult>;

  surface_describe_tool(args: { name?: string; toolId?: string }): Promise<ToolDescription>;

  surface_call(args: SurfaceCallInput): Promise<SurfaceCallResult>;

  surface_probe(args: { name?: string; toolId?: string; role: string }): Promise<SurfaceProbeResult>;

  surface_sample_inputs(args: { name?: string; toolId?: string }): Promise<SurfaceSampleInputsResult>;

  surface_login_status(args: { role: string }): Promise<SurfaceLoginStatusResult>;

  surface_relogin(args: { role: string }): Promise<{ ok: boolean; error?: string }>;

  surface_routes_for_page(args: { pagePath: string }): Promise<SurfaceRoutesForPageResult>;
}

// HTTP-based implementation targeting a live SurfaceMCP instance.
export class HttpSurfaceMcpAdapter implements SurfaceMcpAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async mcpCall<T>(tool: string, args: unknown): Promise<T> {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    };
    const res = await fetch(`${this.baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`SurfaceMCP HTTP ${res.status}: ${await res.text()}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      // Parse SSE stream — collect all data lines, last result wins
      const text = await res.text();
      const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
      if (dataLines.length === 0) throw new Error('Empty SSE stream from SurfaceMCP');
      const last = dataLines[dataLines.length - 1].slice(6);
      const parsed = JSON.parse(last) as { result?: { content?: Array<{ text?: string }> }; error?: unknown };
      if (parsed.error) throw new Error(`SurfaceMCP error: ${JSON.stringify(parsed.error)}`);
      const content = parsed.result?.content?.[0]?.text;
      if (!content) throw new Error('No content in SurfaceMCP response');
      return JSON.parse(content) as T;
    }
    const json = await res.json() as { result?: { content?: Array<{ text?: string }> }; error?: unknown };
    if (json.error) throw new Error(`SurfaceMCP error: ${JSON.stringify(json.error)}`);
    const content = json.result?.content?.[0]?.text;
    if (!content) throw new Error('No content in SurfaceMCP response');
    return JSON.parse(content) as T;
  }

  async surface_list_tools(filter?: {
    method?: string;
    sideEffect?: string;
    pathPrefix?: string;
    confidence?: string;
  }): Promise<SurfaceListToolsResult> {
    return this.mcpCall<SurfaceListToolsResult>('surface_list_tools', { filter });
  }

  async surface_describe_tool(args: { name?: string; toolId?: string }): Promise<ToolDescription> {
    return this.mcpCall<ToolDescription>('surface_describe_tool', args);
  }

  async surface_call(args: SurfaceCallInput): Promise<SurfaceCallResult> {
    return this.mcpCall<SurfaceCallResult>('surface_call', args);
  }

  async surface_probe(args: { name?: string; toolId?: string; role: string }): Promise<SurfaceProbeResult> {
    return this.mcpCall<SurfaceProbeResult>('surface_probe', args);
  }

  async surface_sample_inputs(args: { name?: string; toolId?: string }): Promise<SurfaceSampleInputsResult> {
    return this.mcpCall<SurfaceSampleInputsResult>('surface_sample_inputs', args);
  }

  async surface_login_status(args: { role: string }): Promise<SurfaceLoginStatusResult> {
    return this.mcpCall<SurfaceLoginStatusResult>('surface_login_status', args);
  }

  async surface_relogin(args: { role: string }): Promise<{ ok: boolean; error?: string }> {
    return this.mcpCall<{ ok: boolean; error?: string }>('surface_relogin', args);
  }

  async surface_routes_for_page(args: { pagePath: string }): Promise<SurfaceRoutesForPageResult> {
    return this.mcpCall<SurfaceRoutesForPageResult>('surface_routes_for_page', args);
  }
}
