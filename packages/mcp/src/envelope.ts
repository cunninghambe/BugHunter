// Shared MCP tool response helpers — single source of truth for toolOk / toolErr.

export type ToolOk = { content: [{ type: 'text'; text: string }] };
export type ToolErr = { content: [{ type: 'text'; text: string }]; isError: true };

export function toolOk(data: unknown): ToolOk {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

export function toolErr(code: string, message: string, extra?: Record<string, unknown>): ToolErr {
  const body = extra !== undefined ? { error: code, message, ...extra } : { error: code, message };
  return { content: [{ type: 'text', text: JSON.stringify(body) }], isError: true };
}
