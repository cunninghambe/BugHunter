// Adapter for ClaudeMCP at http://127.0.0.1:3101/mcp.
// Used by the auto-fix loop to dispatch one claude_run per cluster.

export type ClaudeRunArgs = {
  project: string;
  prompt: string;
  sessionId?: string;
  allowedTools?: string[];
  timeoutMs?: number;
};

export type ClaudeJobStatus = {
  state: 'queued' | 'running' | 'done' | 'failed' | 'interrupted' | 'cancelled';
  output?: string;
  error?: string;
  commitSha?: string;
  branch?: string;
};

export type ClaudeRunResult = {
  jobId: string;
};

export interface ClaudeMcpAdapter {
  claude_run(args: ClaudeRunArgs): Promise<ClaudeRunResult>;
  claude_job_status(args: { jobId: string }): Promise<ClaudeJobStatus>;
}

export class HttpClaudeMcpAdapter implements ClaudeMcpAdapter {
  private readonly baseUrl: string;

  constructor(baseUrl: string = 'http://127.0.0.1:3101/mcp') {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  private async mcpCall<T>(tool: string, args: unknown): Promise<T> {
    const body = {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    };
    const res = await fetch(this.baseUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`ClaudeMCP HTTP ${res.status}: ${await res.text()}`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      const text = await res.text();
      const dataLines = text.split('\n').filter(l => l.startsWith('data: '));
      if (dataLines.length === 0) throw new Error('Empty SSE stream from ClaudeMCP');
      const last = dataLines[dataLines.length - 1].slice(6);
      const parsed = JSON.parse(last) as { result?: { content?: Array<{ text?: string }> }; error?: unknown };
      if (parsed.error) throw new Error(`ClaudeMCP error: ${JSON.stringify(parsed.error)}`);
      const content = parsed.result?.content?.[0]?.text;
      if (!content) throw new Error('No content in ClaudeMCP response');
      return JSON.parse(content) as T;
    }
    const json = await res.json() as { result?: { content?: Array<{ text?: string }> }; error?: unknown };
    if (json.error) throw new Error(`ClaudeMCP error: ${JSON.stringify(json.error)}`);
    const content = json.result?.content?.[0]?.text;
    if (!content) throw new Error('No content in ClaudeMCP response');
    return JSON.parse(content) as T;
  }

  claude_run(args: ClaudeRunArgs): Promise<ClaudeRunResult> {
    return this.mcpCall<ClaudeRunResult>('claude_run', args);
  }

  claude_job_status(args: { jobId: string }): Promise<ClaudeJobStatus> {
    return this.mcpCall<ClaudeJobStatus>('claude_job_status', args);
  }
}
