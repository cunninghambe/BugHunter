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
  // 0. Production-host guard for IDOR mutating probes (v0.21 SPEC §2: local apps only).
  // V21 fires cross-user-id mutations; refuse non-loopback unless explicitly opted in.
  if (opts.config.idor?.probeMutating === true && opts.config.idor.allowRemoteHost !== true) {
    if (!isLoopbackUrl(opts.config.surfaceMcpUrl)) {
      throw new Error(
        `idor.probeMutating refuses non-loopback surfaceMcpUrl (${opts.config.surfaceMcpUrl}). ` +
        `BugHunter is local-only by design. Set idor.allowRemoteHost: true to override (you are responsible).`
      );
    }
  }

  // v0.19 EC-12: race tests require per-test or per-page reset policy
  if (
    opts.config.raceConditions?.enabled === true &&
    opts.config.resetPolicy === 'per-run'
  ) {
    throw new Error(
      'race tests require per-test or per-page reset policy, but resetPolicy is "per-run". ' +
      'Change resetPolicy to "per-test" (recommended for transactional DBs) or disable race tests ' +
      'with raceConditions.enabled = false.'
    );
  }

  // v0.36 EC-3: forced-permission-deny with per-run reset may contaminate other tests
  if (
    opts.config.browserPlatform?.enableForcedPermissionDeny === true &&
    opts.config.resetPolicy === 'per-run'
  ) {
    log.warn(
      'browserPlatform.enableForcedPermissionDeny is true with resetPolicy "per-run". ' +
      'Forced permission denials may contaminate other tests. ' +
      'Consider resetPolicy "per-test" or "per-page" to isolate permission state.'
    );
  }

  // v0.40 EC-1: multi-context N must be in [2, 8]
  const multiContextN = opts.config.multiContext?.n;
  if (multiContextN !== undefined && (multiContextN < 2 || multiContextN > 8)) {
    throw new Error(
      `multiContext.n must be between 2 and 8 (got ${multiContextN}). ` +
      `Set multiContext.n to a value in [2, 8] or omit to use the default of 3.`
    );
  }

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

  // v0.20: network-fault capability probe — abort if enabled but camofox lacks the tool.
  if (opts.config.networkFaults?.enabled === true) {
    if (opts.browserMcp === undefined) {
      throw new Error(
        'networkFaults.enabled = true requires a browser adapter (browserMcpUrl or browserMcpStdio). ' +
        'Configure a browser transport and retry.'
      );
    }
    if (opts.browserMcp.applyNetworkFault === undefined) {
      throw new Error(
        'networkFaults.enabled = true but camofox-mcp v0.1 does not support network-fault injection. ' +
        'Required: camofox-mcp ≥ v0.2 with the network_fault tool. See SPEC_V20_NETWORK_FAULTS.md § 6.'
      );
    }
    // Probe by calling with offline fault and checking the result
    const probeTab = await opts.browserMcp.openTab('about:blank').catch((err: unknown) => {
      throw new Error(`networkFaults probe: could not open probe tab: ${String(err)}`);
    });
    try {
      // Build a tab-scoped apply by calling through the adapter directly
      const probeResult = await opts.browserMcp.applyNetworkFault({ kind: 'offline' }).catch((err: unknown) => {
        throw new Error(`networkFaults probe: applyNetworkFault threw: ${String(err)}`);
      });
      if (probeResult.applied === false && probeResult.reason === 'tool_not_available') {
        throw new Error(
          'networkFaults.enabled = true but camofox-mcp v0.1 does not support network-fault injection. ' +
          'Required: camofox-mcp ≥ v0.2 with the network_fault tool. See SPEC_V20_NETWORK_FAULTS.md § 6.'
        );
      }
      await opts.browserMcp.clearNetworkFault?.();
    } finally {
      await opts.browserMcp.closeTabExplicit(probeTab.tabId).catch(() => {});
    }
    log.info('networkFaults capability probe passed');
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

function isLoopbackUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
  } catch {
    return false;
  }
}
