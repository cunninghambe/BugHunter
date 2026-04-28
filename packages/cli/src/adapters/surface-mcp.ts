// Adapter for SurfaceMCP § 4.1 tool surface.
// All negative-test palette calls must pass noAutoRelogin: true (§ 3.4.3).

import type { ToolMeta, JsonSchema, TriggerSelectorHint } from '../types.js';

export type PageSource = 'static' | 'crawl_seed';

export type SurfacePageMeta = {
  route: string;
  sourceFile: string;
  componentName?: string;
  lazy: boolean;
  dynamicParams: string[];
  declaredAt: { file: string; line: number };
  /** Optional — absent on SurfaceMCP < 0.2.1; undefined ≡ 'static'. */
  source?: PageSource;
};

export type SurfacePageSkip = {
  route: string;
  reason: string;
  detail?: string;
  declaredAt?: { file: string; line: number };
};

export type SurfaceListPagesResult = {
  revision: number;
  pages: SurfacePageMeta[];
  skips?: SurfacePageSkip[];
};

export type SurfaceDescribeSelfResult = {
  name: string;
  stack: 'nextjs' | 'express' | 'fastapi' | 'django' | 'openapi' | 'vite';
  baseUrl: string;
  toolRevision: number;
  pageRevision: number;
  capabilities: {
    listPages: boolean;
    /** Optional — absent on SurfaceMCP < 0.2.1. Signals that seed pages may be returned. */
    crawlSeed?: boolean;
    /** Optional — absent on SurfaceMCP < 0.2.2. Present when surface_list_navigations is available. */
    listNavigations?: boolean;
    /** Optional — absent on SurfaceMCP < 0.2.2. Present when surface_enumerate_routes_runtime is available. */
    enumerateRoutesRuntime?: boolean;
  };
};

export type SurfaceNavigation = {
  label: string;
  method: 'link' | 'router-link' | 'router-push' | 'state-setter';
  target: string;
  kind: 'url' | 'state' | 'hash';
  stateVar?: string;
  triggerSelectorHint: TriggerSelectorHint;
  sourceFile: string;
  sourceLine: number;
  confidence: 'high' | 'medium' | 'low';
};

export type SurfaceListNavigationsResult = {
  revision: number;
  navigations: SurfaceNavigation[];
  skips: Array<{ reason: string; detail?: string; declaredAt?: { file: string; line: number } }>;
};

export type SurfaceRuntimeEnumScript = {
  version: number;
  script: string;
  timeoutMs: number;
  expectedSchema: unknown;
};

export type SurfacePostprocessedRoute = {
  path: string;
  params: string[];
  source: 'tanstack-router' | 'react-router-v6' | 'react-router-v5' | 'wouter' | 'vue-router' | 'next-router' | 'none';
};

export type SurfacePostprocessResult = {
  routes: SurfacePostprocessedRoute[];
  summary: {
    detectedRouters: string[];
    errorCount: number;
    totalRoutes: number;
    dedupedRoutes: number;
    fellBackToNone: boolean;
  };
};

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

export type SuccessCheck =
  | { kind: 'redirect'; to: string }
  | { kind: 'cookie'; name: string }
  | { kind: 'status'; code: number };

export type DescribeAuthResult =
  | { authKind: 'none'; reason: 'no_auth_configured' }
  | { authKind: 'bearer'; reason: 'programmatic_only'; detail: string }
  | { authKind: 'api_key'; reason: 'programmatic_only'; detail: string }
  | { authKind: 'anonymous'; reason: 'role_has_no_credentials' }
  | {
      authKind: 'form';
      uiLoginPath: string;
      uiTriggerSelector?: string;
      uiSubmitSelector?: string;
      fields: Record<string, string>;
      values: Record<string, string>;
      successCheck: SuccessCheck;
      cookieName?: string;
    }
  | {
      authKind: 'nextauth';
      uiLoginPath: string;
      uiTriggerSelector?: string;
      uiSubmitSelector?: string;
      fields: Record<string, string>;
      values: Record<string, string>;
      successCheck: SuccessCheck;
      cookieName: string;
    };

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

  surface_list_pages(filter?: { pathPrefix?: string; lazy?: boolean }): Promise<SurfaceListPagesResult>;

  surface_describe_self(): Promise<SurfaceDescribeSelfResult>;

  surface_describe_auth(args: { role: string }): Promise<DescribeAuthResult>;

  surface_list_navigations(filter?: { method?: string; kind?: string }): Promise<SurfaceListNavigationsResult>;

  surface_enumerate_routes_runtime(): Promise<SurfaceRuntimeEnumScript>;

  surface_postprocess_runtime_routes(args: { raw: unknown }): Promise<SurfacePostprocessResult>;
}

// HTTP-based implementation targeting a live SurfaceMCP instance.
export class HttpSurfaceMcpAdapter implements SurfaceMcpAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string) {
    // Strip one trailing /mcp (with optional trailing slash) for backward-compat
    // with configs that include the path. The adapter appends /mcp internally.
    this.baseUrl = baseUrl.replace(/\/mcp\/?$/, '').replace(/\/$/, '');
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
      const text = await res.text();
      const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
      if (dataLines.length === 0) throw new Error('Empty SSE stream from SurfaceMCP');
      const last = dataLines[dataLines.length - 1].slice(6);
      const parsed = JSON.parse(last) as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
      if (parsed.error) throw new Error(`SurfaceMCP error: ${JSON.stringify(parsed.error)}`);
      const content = parsed.result?.content?.[0]?.text;
      if (!content) throw new Error('No content in SurfaceMCP response');
      if (parsed.result?.isError) throw new Error(`SurfaceMCP tool error (${tool}): ${content}`);
      return JSON.parse(content) as T;
    }
    const json = await res.json() as { result?: { content?: Array<{ text?: string }>; isError?: boolean }; error?: unknown };
    if (json.error) throw new Error(`SurfaceMCP error: ${JSON.stringify(json.error)}`);
    const content = json.result?.content?.[0]?.text;
    if (!content) throw new Error('No content in SurfaceMCP response');
    if (json.result?.isError) throw new Error(`SurfaceMCP tool error (${tool}): ${content}`);
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

  async surface_list_pages(filter?: { pathPrefix?: string; lazy?: boolean }): Promise<SurfaceListPagesResult> {
    return this.mcpCall<SurfaceListPagesResult>('surface_list_pages', { filter });
  }

  async surface_describe_self(): Promise<SurfaceDescribeSelfResult> {
    return this.mcpCall<SurfaceDescribeSelfResult>('surface_describe_self', {});
  }

  async surface_describe_auth(args: { role: string }): Promise<DescribeAuthResult> {
    return this.mcpCall<DescribeAuthResult>('surface_describe_auth', args);
  }

  async surface_list_navigations(filter?: { method?: string; kind?: string }): Promise<SurfaceListNavigationsResult> {
    return this.mcpCall<SurfaceListNavigationsResult>('surface_list_navigations', { filter });
  }

  async surface_enumerate_routes_runtime(): Promise<SurfaceRuntimeEnumScript> {
    return this.mcpCall<SurfaceRuntimeEnumScript>('surface_enumerate_routes_runtime', {});
  }

  async surface_postprocess_runtime_routes(args: { raw: unknown }): Promise<SurfacePostprocessResult> {
    return this.mcpCall<SurfacePostprocessResult>('surface_postprocess_runtime_routes', args);
  }
}
