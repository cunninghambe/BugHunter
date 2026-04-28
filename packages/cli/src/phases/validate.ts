// Phase 0: validate — check reachability and resume validity (§ 3.2).

import type { BugHunterConfig, RunState } from '../types.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { log } from '../log.js';

export type ValidateOptions = {
  surfaceMcp: SurfaceMcpAdapter;
  browserMcp?: BrowserMcpAdapter;
  config: BugHunterConfig;
  resumeState?: RunState;
  forceResume?: boolean;
};

export type ValidateResult = {
  revision: number;
  roles: string[];
};

export async function runValidate(opts: ValidateOptions): Promise<ValidateResult> {
  // 1. SurfaceMCP reachable
  const catalog = await opts.surfaceMcp.surface_list_tools().catch((err: unknown) => {
    throw new Error(`SurfaceMCP unreachable at ${opts.config.surfaceMcpUrl}: ${String(err)}`);
  });

  log.info('SurfaceMCP reachable', { revision: catalog.revision, toolCount: catalog.tools.length });

  // 2. Browser MCP reachable (if configured)
  if (opts.browserMcp !== undefined) {
    await opts.browserMcp.listTabs().catch((err: unknown) => {
      throw new Error(`Browser MCP unreachable: ${String(err)}`);
    });
    log.info('Browser MCP reachable');
  }

  // 3. Login check per role
  const roles = opts.config.roles ?? extractRolesFromCatalog(catalog.tools);
  const failedRoles: string[] = [];

  for (const role of roles) {
    const status = await opts.surfaceMcp.surface_login_status({ role }).catch(() => null);
    if (status?.authenticated !== true) {
      const reloginResult = await opts.surfaceMcp.surface_relogin({ role }).catch(() => null);
      if (reloginResult?.ok !== true) {
        failedRoles.push(role);
        log.warn(`Login failed for role: ${role}`);
      }
    }
  }

  if (failedRoles.length > 0) {
    throw new Error(`Login failed for roles: ${failedRoles.join(', ')}. Aborting.`);
  }

  // 4. Resume validity check
  if (opts.resumeState !== undefined) {
    const savedRevision = opts.resumeState.surfaceRevision;
    if (savedRevision !== undefined && savedRevision !== catalog.revision) {
      if (opts.forceResume !== true) {
        throw new Error(
          `SurfaceMCP revision changed (was ${savedRevision}, now ${catalog.revision}). ` +
          `Use --force-resume to override.`
        );
      }
      log.warn('Revision mismatch — force-resume active', { savedRevision, currentRevision: catalog.revision });
    }
  }

  return { revision: catalog.revision, roles };
}

function extractRolesFromCatalog(_tools: unknown[]): string[] {
  // If no roles configured, default to ['anonymous']
  // Real role extraction would come from SurfaceMCP tool metadata
  return ['anonymous'];
}
