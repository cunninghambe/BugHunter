// bughunter config validate | show — Zod validation + effective config dump.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { ConfigSchema, loadConfig, resolvedConfig, effectiveForbiddenPaths } from '../config.js';
import { HttpSurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BugHunterConfig } from '../types.js';
import { log } from '../log.js';

type ConfigCommandOptions = {
  resolved?: boolean;
};

const BEARER_RE = /^Bearer /i;
const SENSITIVE_HEADER_RE = /^(authorization|cookie)$/i;

export function configCommand(
  projectDir: string,
  subcommand: 'validate' | 'show',
  opts: ConfigCommandOptions,
): void {
  if (subcommand === 'validate') {
    runValidate(projectDir);
  } else {
    runShow(projectDir, opts.resolved ?? false);
  }
}

function runValidate(projectDir: string): void {
  const configPath = path.join(projectDir, '.bughunter', 'config.json');

  if (!fs.existsSync(configPath)) {
    process.stdout.write(`No .bughunter/config.json found. Run 'bughunter init' first.\n`);
    process.exitCode = 1;
    return;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (err) {
    process.stdout.write(`Invalid .bughunter/config.json: ${String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    process.stdout.write(`Invalid .bughunter/config.json:\n`);
    for (const issue of result.error.issues) {
      const loc = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      process.stdout.write(`  ${loc}: ${issue.message}\n`);
    }
    process.stdout.write(`\nFound ${result.error.issues.length} issue(s). Fix and re-run.\n`);
    process.exitCode = 1;
    return;
  }

  const config = result.data;

  // Palette file (optional) — if present must parse as JSON
  const palettePath = path.join(projectDir, '.bughunter', 'palette.json');
  if (fs.existsSync(palettePath)) {
    try {
      JSON.parse(fs.readFileSync(palettePath, 'utf-8'));
    } catch (err) {
      process.stdout.write(`Invalid .bughunter/palette.json: ${String(err)}\n`);
      process.exitCode = 1;
      return;
    }
  }

  const bodyFixtureCount = Object.keys(config.bodyFixtures ?? {}).length;
  const discoveryFixtureCount = Object.keys(config.discoveryFixtures ?? {}).length;
  const domainHintCount = Object.keys(config.domainHints ?? {}).length;
  const forbiddenPathCount = effectiveForbiddenPaths(config).length;

  process.stdout.write(`Config OK.\n`);
  process.stdout.write(`  bodyFixtures: ${bodyFixtureCount}\n`);
  process.stdout.write(`  discoveryFixtures: ${discoveryFixtureCount}\n`);
  process.stdout.write(`  domainHints: ${domainHintCount}\n`);
  process.stdout.write(`  forbiddenPaths: ${forbiddenPathCount}\n`);

  // Orphan fixture check: configCommand is synchronous; async SurfaceMCP lookup is not
  // possible here. Emit an advisory instead of silently skipping.
  const bodyFixtureKeys = Object.keys(config.bodyFixtures ?? {});
  const discoveryFixtureKeys = Object.keys(config.discoveryFixtures ?? {});
  if (bodyFixtureKeys.length > 0 || discoveryFixtureKeys.length > 0) {
    process.stdout.write(`\nWarnings:\n`);
    process.stdout.write(`  orphan-fixture check skipped: run 'bughunter config validate' in an async context to check SurfaceMCP catalog\n`);
  }
}

function runShow(projectDir: string, useResolved: boolean): void {
  let config: BugHunterConfig;
  try {
    config = loadConfig(projectDir);
  } catch (err) {
    process.stdout.write(`${String(err)}\n`);
    process.exitCode = 1;
    return;
  }

  const effective = useResolved ? resolvedConfig(config) : config;
  const redacted = redactSensitive(effective);

  if (useResolved) {
    // Include effectiveForbiddenPaths in resolved view per spec Q4 resolution
    (redacted as Record<string, unknown>)['forbiddenPaths'] = effectiveForbiddenPaths(config);
  }

  process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
}

function redactSensitive(config: BugHunterConfig): BugHunterConfig {
  const clone = { ...config };

  if (clone.vision?.apiKey !== undefined) {
    clone.vision = { ...clone.vision, apiKey: '[redacted]' };
  }

  if (clone.extraHeaders !== undefined) {
    const redactedHeaders: Record<string, string> = {};
    for (const [key, value] of Object.entries(clone.extraHeaders)) {
      const isSensitive = SENSITIVE_HEADER_RE.test(key) || BEARER_RE.test(value);
      redactedHeaders[key] = isSensitive ? '[redacted]' : value;
    }
    clone.extraHeaders = redactedHeaders;
  }

  return clone;
}

/**
 * Async orphan-fixture check against live SurfaceMCP catalog.
 * Used by tests and future async validate flows.
 * Returns advisory warning strings for any fixture keys not found in SurfaceMCP.
 */
export async function checkOrphansAsync(config: BugHunterConfig): Promise<string[]> {
  const warnings: string[] = [];
  const bodyFixtureKeys = Object.keys(config.bodyFixtures ?? {});
  const discoveryFixtureKeys = Object.keys(config.discoveryFixtures ?? {});

  if (bodyFixtureKeys.length === 0 && discoveryFixtureKeys.length === 0) return warnings;

  const surface = new HttpSurfaceMcpAdapter(config.surfaceMcpUrl);

  let catalogToolIds: Set<string>;
  let pageRoutes: Set<string>;

  try {
    const [toolsResult, pagesResult] = await Promise.all([
      surface.surface_list_tools({}),
      surface.surface_list_pages(),
    ]);
    catalogToolIds = new Set(toolsResult.tools.map(t => t.toolId));
    pageRoutes = new Set(pagesResult.pages.map(p => p.route));
  } catch {
    log.warn('orphan-fixture check skipped: SurfaceMCP unreachable');
    warnings.push('orphan-fixture check skipped: SurfaceMCP unreachable');
    return warnings;
  }

  for (const toolId of bodyFixtureKeys) {
    if (!catalogToolIds.has(toolId)) {
      warnings.push(`orphan bodyFixture: '${toolId}' (toolId not in SurfaceMCP catalog)`);
    }
  }
  for (const route of discoveryFixtureKeys) {
    if (!pageRoutes.has(route)) {
      warnings.push(`orphan discoveryFixture: '${route}' (route not in surface_list_pages)`);
    }
  }

  return warnings;
}
