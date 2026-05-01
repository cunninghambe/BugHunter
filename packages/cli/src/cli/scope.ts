// bughunter scope — dry-run plan stats (validate + discover + plan; no execute).

import { loadConfig } from '../config.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import { CamofoxBrowserMcpAdapter } from '../adapters/browser-mcp.js';
import { runValidate } from '../phases/validate.js';
import { runDiscover } from '../phases/discover.js';
import { runPlan } from '../phases/plan.js';
import type { TestCase } from '../types.js';

type ScopeOptions = {
  route?: string;
  role?: string;
  format: 'table' | 'json';
};

type ScopeResult = {
  filters: { route?: string; role?: string };
  totalTests: number;
  byRole: Record<string, number>;
  byRoute: Record<string, number>;
  byKind: Record<string, number>;
  byPalette: Record<string, number>;
  projectedRuntimeMs: number;
  projectedApiCalls: number;
  skippedRoutes: Array<{ route: string; reason: string }>;
  skipReasons: Array<{ reason: string; count: number }>;
  upgradedToolIds: string[];
};

export async function scopeCommand(projectDir: string, opts: ScopeOptions): Promise<void> {
  const config = loadConfig(projectDir);

  const surfaceMcp = new HttpSurfaceMcpAdapter(config.surfaceMcpUrl);
  const browserMcp = config.browserMcpUrl !== undefined
    ? new CamofoxBrowserMcpAdapter(config.browserMcpUrl)
    : undefined;

  let roles: string[];
  try {
    const validateResult = await runValidate({ surfaceMcp, browserMcp, config });
    roles = validateResult.roles;
  } catch (err) {
    process.stdout.write(`scope: validate failed — ${String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const filteredRoles = opts.role !== undefined ? [opts.role] : roles;

  // Use in-memory runId — never written to disk
  const runId = `scope-${Date.now()}`;

  let discovery;
  try {
    discovery = await runDiscover(
      projectDir,
      config,
      filteredRoles,
      runId,
      surfaceMcp,
      browserMcp,
      opts.route,
    );
  } catch (err) {
    process.stdout.write(`scope: discover failed — ${String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  let planResult;
  try {
    planResult = await runPlan(runId, discovery, config, filteredRoles, surfaceMcp);
  } catch (err) {
    process.stdout.write(`scope: plan failed — ${String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const { testCases, projectedRuntimeMs, skipReasons, upgradedToolIds } = planResult;

  const result: ScopeResult = {
    filters: { route: opts.route, role: opts.role },
    totalTests: testCases.length,
    byRole: histogram(testCases, t => t.role),
    byRoute: topN(histogram(testCases, t => t.page), 20),
    byKind: histogram(testCases, t => t.action.kind),
    byPalette: histogram(testCases, t => t.action.palette),
    projectedRuntimeMs,
    projectedApiCalls: testCases.filter(t => t.action.via === 'api').length,
    skippedRoutes: discovery.skipList
      .filter((s): s is typeof s & { route: string } => s.route !== undefined)
      .map(s => ({ route: s.route, reason: s.reason })),
    skipReasons,
    upgradedToolIds,
  };

  if (opts.format === 'json') {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  printTable(result, config.projectName);
}

function histogram(testCases: TestCase[], key: (t: TestCase) => string): Record<string, number> {
  const map: Record<string, number> = {};
  for (const t of testCases) {
    const k = key(t);
    map[k] = (map[k] ?? 0) + 1;
  }
  return map;
}

function topN(map: Record<string, number>, n: number): Record<string, number> {
  return Object.fromEntries(
    Object.entries(map).sort(([, a], [, b]) => b - a).slice(0, n),
  );
}

function fmtMs(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function printTable(result: ScopeResult, projectName: string): void {
  process.stdout.write(`BugHunter scope — ${projectName}\n`);
  const filterParts: string[] = [];
  if (result.filters.route !== undefined) filterParts.push(`route=${result.filters.route}`);
  if (result.filters.role !== undefined) filterParts.push(`role=${result.filters.role}`);
  if (filterParts.length > 0) {
    process.stdout.write(`Filters: ${filterParts.join('  ')}\n`);
  }
  process.stdout.write('\n');

  process.stdout.write(`Total tests planned:   ${result.totalTests}\n`);

  if (result.totalTests === 0) {
    process.stdout.write(
      'Advisory: No tests match the route/role filter. Try without --route to confirm discovery is finding pages.\n',
    );
    return;
  }

  const roleStr = Object.entries(result.byRole).map(([r, n]) => `${r}:${n}`).join('  ');
  process.stdout.write(`By role:               ${roleStr}\n`);

  const topRoutes = Object.entries(result.byRoute).slice(0, 5).map(([r, n]) => `${r}:${n}`).join('  ');
  process.stdout.write(`By route (top 5):      ${topRoutes}\n`);

  const kindStr = Object.entries(result.byKind).sort(([, a], [, b]) => b - a).map(([k, n]) => `${k}:${n}`).join('  ');
  process.stdout.write(`By action kind:        ${kindStr}\n`);

  const paletteStr = Object.entries(result.byPalette).sort(([, a], [, b]) => b - a).map(([p, n]) => `${p}:${n}`).join('  ');
  process.stdout.write(`By palette:            ${paletteStr}\n`);

  const avgMs = 7500;
  process.stdout.write(`\nProjected runtime:     ${fmtMs(result.projectedRuntimeMs)} (${result.totalTests} x ${avgMs / 1000}s avg)\n`);
  process.stdout.write(`Projected API calls:   ${result.projectedApiCalls}\n`);
  process.stdout.write(`Skipped routes:        ${result.skippedRoutes.length}\n`);

  for (const s of result.skippedRoutes) {
    process.stdout.write(`  - ${s.route}       reason: ${s.reason}\n`);
  }

  process.stdout.write(`\nPlan upgrades:         ${result.upgradedToolIds.length} unknown-confidence tools probed\n`);
}
