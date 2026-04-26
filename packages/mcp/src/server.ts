// BugHunter MCP server — optional HTTP wrapper (§ 4.3).

import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';

const PORT = parseInt(process.env.BUGHUNTER_MCP_PORT ?? '3103', 10);

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  app.post('/mcp', async (req: Request, res: Response) => {
    const server = new McpServer({ name: 'bughunter-mcp', version: '0.1.0' });
    registerTools(server);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body as unknown);
    } catch (err) {
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    } finally {
      await server.close().catch(() => {});
    }
  });

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'bughunter-mcp' });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createApp();
  app.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`BugHunter MCP server running on http://127.0.0.1:${PORT}/mcp\n`);
  });
}
