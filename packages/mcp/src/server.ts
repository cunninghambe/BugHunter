// BugHunter MCP server — optional HTTP wrapper (§ 4.3).

import express, { type Request, type Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerTools } from './tools.js';
import {
  registerClustersTool, registerClusterDetailTool, registerOccurrenceTool,
  registerArtifactTool, registerRunsListTool, registerRunSummaryTool,
  registerDetectorsTool, registerDiffTool, registerHistoryTool,
  registerExplainTool, registerProjectDescribeTool, registerConfigGetTool,
  registerTailTool, registerProgressTool,
} from './tools.js';
import { requireApiKey } from './auth.js';
import { registerSuppressTools } from './tools/suppress.js';
import { registerTriageTool } from './tools/triage.js';
import { registerFixCoordTools, reconcileFixJobs } from './tools/fix-coord.js';
import { registerConfigSetTool } from './tools/config-set.js';
import { registerMinimizeTools } from './tools/minimize.js';
import { registerBaselineTools } from './tools/baseline.js';

const PORT = parseInt(process.env.BUGHUNTER_MCP_PORT ?? '3103', 10);
const AUTH_DISABLED = process.env.BUGHUNTER_MCP_REQUIRE_AUTH === '0';

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const mcpHandler = async (req: Request, res: Response): Promise<void> => {
    const server = new McpServer({ name: 'bughunter-mcp', version: '0.30.0' });
    registerTools(server);

    // Register all V30 read-side tools
    registerClustersTool(server);
    registerClusterDetailTool(server);
    registerOccurrenceTool(server);
    registerArtifactTool(server);
    registerRunsListTool(server);
    registerRunSummaryTool(server);
    registerDetectorsTool(server);
    registerDiffTool(server);
    registerHistoryTool(server);
    registerExplainTool(server);
    registerProjectDescribeTool(server);
    registerConfigGetTool(server);
    registerTailTool(server);
    registerProgressTool(server);

    // V31 write-side tools
    registerSuppressTools(server);
    registerTriageTool(server);
    registerFixCoordTools(server);
    registerConfigSetTool(server);
    registerMinimizeTools(server);
    registerBaselineTools(server);

    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body as unknown);
    } catch {
      if (!res.headersSent) res.status(500).json({ error: 'Internal server error' });
    } finally {
      await server.close().catch(() => {});
    }
  };

  if (AUTH_DISABLED) {
    app.post('/mcp', mcpHandler);
  } else {
    app.post('/mcp', requireApiKey, mcpHandler);
  }

  app.get('/health', (_req: Request, res: Response) => {
    res.json({ ok: true, service: 'bughunter-mcp' });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // On server restart: reconcile any orphaned fix jobs from a previous process.
  const fixProjectDir = process.env['BUGHUNTER_PROJECT_DIR'];
  if (fixProjectDir !== undefined && fixProjectDir !== '') {
    reconcileFixJobs(fixProjectDir);
  }

  const app = createApp();
  app.listen(PORT, '127.0.0.1', () => {
    process.stdout.write(`BugHunter MCP server running on http://127.0.0.1:${PORT}/mcp\n`);
  });
}
