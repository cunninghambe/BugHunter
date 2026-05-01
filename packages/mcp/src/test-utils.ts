// Test utilities for MCP tool handler invocation.
// Accesses the MCP SDK's internal _registeredTools registry to call tool handlers directly.
// This uses an intentional type cast to access private internals for testing purposes.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export function getToolHandler(server: McpServer, name: string): ToolHandler {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access -- accessing private SDK internals for testing
  const tools = (server as any)._registeredTools as Record<string, { handler: ToolHandler } | undefined>;
  const tool = tools[name];
  if (tool === undefined) throw new Error(`Tool ${name} not registered`);
  return tool.handler;
}

export function makeServer(register: (server: McpServer) => void): McpServer {
  const server = new McpServer({ name: 'test', version: '0.0.1' });
  register(server);
  return server;
}
