// bughunt_config_get — read a project's BugHunter config.
// CLI parity: bughunter config show [--resolved]

import { z } from 'zod';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { toolOk, toolErr } from '../envelope.js';
import { resolveProjectDir } from '../io/runs.js';
import { NotFoundError, InvalidArgumentError } from '../io/runs.js';

const InputSchema = z.object({
  projectDir: z.string().min(1).describe('Absolute path to the project directory'),
  resolved: z.boolean().default(false)
    .describe('When true, returns the config with all defaults applied via Zod parse; when false, returns the raw file contents'),
});

export function registerConfigGetTool(server: McpServer): void {
  server.tool(
    'bughunt_config_get',
    'Read a project\'s BugHunter config, either raw (the contents of .bughunter/config.json) or resolved (with all defaults applied via Zod parse). Use resolved: true when you need to see the effective settings the run will use.',
    InputSchema.shape,
    async (args) => {
      try {
        const projectDir = resolveProjectDir(args.projectDir);
        const configPath = path.join(projectDir, '.bughunter', 'config.json');

        if (!fs.existsSync(configPath)) {
          return toolErr('not_found', `.bughunter/config.json not found in ${projectDir}`);
        }

        let raw: unknown;
        try {
          raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        } catch (e) {
          return toolErr('error', `Failed to read config.json: ${String(e)}`);
        }

        if (!args.resolved) {
          return toolOk(raw);
        }

        // Resolved: dynamic import the CLI's config schema and parse with defaults
        try {
          const configModule = await import('bughunter/src/config.js') as { parseConfig?: (raw: unknown) => unknown };
          if (typeof configModule.parseConfig === 'function') {
            const resolved = configModule.parseConfig(raw);
            return toolOk(resolved);
          }
          // Fallback: return raw if no parseConfig is available
          return toolOk(raw);
        } catch {
          // Config module not available or parse failed — return raw with a note
          return toolOk({ ...(raw as Record<string, unknown>), _note: 'resolved=true requested but CLI config parser unavailable; returning raw' });
        }
      } catch (e) {
        if (e instanceof NotFoundError) return toolErr('not_found', e.message);
        if (e instanceof InvalidArgumentError) return toolErr('invalid_argument', e.message);
        return toolErr('error', String(e));
      }
    },
  );
}
