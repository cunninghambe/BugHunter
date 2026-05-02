// v0.44: bughunter calibrate — run BugHunter against a bench app and compare to gold.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import { loadGoldStandard } from '../calibrate/gold.js';
import { matchClustersToGold, MissingBugIdentityError, DuplicateBugIdentityError, extractIdentityUpdates } from '../calibrate/match.js';
import { aggregateReport, formatSummaryLine } from '../calibrate/report.js';
import { recordIdentitiesInGold } from '../calibrate/gold.js';
import type { CalibrationReport, AcceptanceThresholds } from '../calibrate/types.js';
import { DETECTOR_REGISTRY } from '../detectors/registry.js';
import { runCommand } from './run.js';
import { listRunIds, runPaths, writeJsonFile } from '../store/filesystem.js';
import type { BugCluster } from '../types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type CalibrateOptions = {
  appPath: string;
  goldPath?: string;
  outPath?: string;
  enforceThresholds?: boolean;
  thresholdsPath?: string;
  recordIdentities?: boolean;
  force?: boolean;
  noBootTeardown?: boolean;
  jsonOutput?: boolean;
};

// ---------------------------------------------------------------------------
// bughunter.config.json partial shape
// ---------------------------------------------------------------------------

type BughunterConfig = {
  projectName: string;
  baseUrl: string;
  calibrate?: {
    seedScript?: string;
    bootScript?: string;
    teardownScript?: string;
    healthCheckUrl?: string;
    healthCheckTimeoutMs?: number;
  };
};

// ---------------------------------------------------------------------------
// Bench app manifest shape (top-level MANIFEST.json or per-app package.json)
// ---------------------------------------------------------------------------

type AppManifestStub = {
  benchVersion?: string;
  version?: string;
};

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function loadBughunterConfig(appPath: string): BughunterConfig {
  const configPath = path.join(appPath, 'bughunter.config.json');
  if (!fs.existsSync(configPath)) {
    throw new CalibrateSetupError(`bughunter.config.json not found at ${configPath}`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8')) as BughunterConfig;
}

function loadThresholds(thresholdsPath: string | undefined): AcceptanceThresholds {
  const resolved = thresholdsPath ?? path.join(findBugHunterRoot(), 'acceptance-thresholds.json');
  if (!fs.existsSync(resolved)) {
    // Fall back to built-in defaults
    return {
      default: { precision: 0.85, recall: 0.80 },
      perKind: {
        visual_anomaly: { precision: 0.70, recall: 0.70, rationale: 'Visual diffs are inherently noisy.' },
        axe_color_contrast_strong: { precision: 0.80, recall: 0.85, rationale: 'axe-core contrast differences across browsers.' },
        memory_leak_attributed: { precision: 0.75, recall: 0.75, rationale: 'Heap-attribution is approximate.' },
      },
    };
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf-8')) as AcceptanceThresholds;
}

/** Walk up from __dirname to find the BugHunter repo root (contains acceptance-thresholds.json). */
function findBugHunterRoot(): string {
  // __dirname is packages/cli/dist/cli/ at runtime; walk up 4 levels
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'acceptance-thresholds.json');
    if (fs.existsSync(candidate)) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

function runScript(script: string, appPath: string, label: string): void {
  const result = child_process.spawnSync(script, {
    cwd: appPath,
    shell: true,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    throw new CalibrateEnvironmentError(
      `${label} script exited with code ${result.status ?? 'unknown'}. Script: ${script}`,
    );
  }
}

function pollHealthCheck(url: string, timeoutMs: number): void {
  const deadline = Date.now() + timeoutMs;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const result = child_process.spawnSync(
        'node',
        ['-e', `const http=require('http');const u=new URL('${url}');http.get({hostname:u.hostname,port:u.port,path:u.pathname},r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))`],
        { timeout: 3000 },
      );
      if (result.status === 0) return;
      lastErr = `Status: ${result.status}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
    // Brief pause between polls — not a loop-sleep pattern, just a retry mechanism
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
  }
  throw new CalibrateEnvironmentError(
    `Health check timed out after ${timeoutMs}ms for ${url}. Last error: ${lastErr}`,
  );
}

function latestRunId(projectDir: string): string {
  const ids = listRunIds(projectDir).sort();
  if (ids.length === 0) throw new CalibrateRunError('No runs found after BugHunter run completed.');
  return ids[ids.length - 1];
}

function readClusters(projectDir: string, runId: string): BugCluster[] {
  const paths = runPaths(projectDir, runId);
  if (!fs.existsSync(paths.summaryFile)) {
    throw new CalibrateRunError(`summary.json not found at ${paths.summaryFile}`);
  }
  const summary = JSON.parse(fs.readFileSync(paths.summaryFile, 'utf-8')) as { clusters?: BugCluster[]; partial?: boolean };
  if (summary.partial === true) {
    throw new CalibrateRunError(
      'Underlying BugHunter run is partial (crashed or timed out). Cannot calibrate a partial run.',
    );
  }
  // summary.json does not include a clusters array — clusters are written to bugs.jsonl.
  if (summary.clusters !== undefined) return summary.clusters;
  if (!fs.existsSync(paths.bugsFile)) return [];
  return fs.readFileSync(paths.bugsFile, 'utf-8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line) as BugCluster);
}

function resolveBenchVersion(appPath: string): string {
  const pkgPath = path.join(appPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as AppManifestStub;
    if (pkg.version !== undefined) return pkg.version;
  }
  // Try MANIFEST.json one level up
  const manifestPath = path.join(appPath, '..', '..', 'MANIFEST.json');
  if (fs.existsSync(manifestPath)) {
    const mf = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as AppManifestStub;
    if (mf.benchVersion !== undefined) return mf.benchVersion;
  }
  return '0.0.0';
}

function resolveGitCommit(): string {
  try {
    const result = child_process.spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf-8' });
    return result.stdout.trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

// ---------------------------------------------------------------------------
// Error types — discriminate by constructor for exit code mapping
// ---------------------------------------------------------------------------

export class CalibrateSetupError extends Error {
  constructor(message: string) { super(message); this.name = 'CalibrateSetupError'; }
}

export class CalibrateEnvironmentError extends Error {
  constructor(message: string) { super(message); this.name = 'CalibrateEnvironmentError'; }
}

export class CalibrateGoldError extends Error {
  constructor(message: string) { super(message); this.name = 'CalibrateGoldError'; }
}

export class CalibrateRunError extends Error {
  constructor(message: string) { super(message); this.name = 'CalibrateRunError'; }
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export async function calibrateCommand(opts: CalibrateOptions): Promise<void> {
  const appPath = path.resolve(opts.appPath);

  // Step 1: load config
  const config = loadBughunterConfig(appPath);
  const benchVersion = resolveBenchVersion(appPath);
  const goldPath = opts.goldPath ?? path.join(appPath, 'gold-standard.jsonl');

  // Step 2: validate gold
  const goldResult = loadGoldStandard(goldPath);
  if (!goldResult.ok) {
    const msgs = goldResult.errors.map(e => `  line ${e.lineNumber}: ${e.message}`).join('\n');
    throw new CalibrateGoldError(`Gold-standard validation failed:\n${msgs}`);
  }
  const goldEntries = goldResult.entries;

  // Cross-check: every gold kind must be in DETECTOR_REGISTRY
  const registryKinds = new Set(DETECTOR_REGISTRY.map(e => e.kind));
  const unknownKinds = goldEntries.filter(e => !registryKinds.has(e.kind as never));
  if (unknownKinds.length > 0) {
    throw new CalibrateGoldError(
      `Gold entries reference unknown BugKinds (requires V26+V27): ${unknownKinds.map(e => `${e.goldId}:${e.kind}`).join(', ')}`,
    );
  }

  // Cross-check: deferred kinds must only have expected: 'detector_silent'
  const badDeferred = goldEntries.filter(e => {
    const reg = DETECTOR_REGISTRY.find(r => r.kind === e.kind);
    return reg?.status === 'deferred' && e.expected === 'detector_fires';
  });
  if (badDeferred.length > 0) {
    throw new CalibrateGoldError(
      `Deferred kind gold entries must have expected: 'detector_silent'. Offending: ${badDeferred.map(e => e.goldId).join(', ')}`,
    );
  }

  // Step 3: boot (unless --no-boot)
  const calibrateCfg = config.calibrate;
  if (!opts.noBootTeardown && calibrateCfg?.bootScript !== undefined) {
    if (calibrateCfg.seedScript !== undefined) {
      runScript(calibrateCfg.seedScript, appPath, 'seed');
    }
    runScript(calibrateCfg.bootScript, appPath, 'boot');
    if (calibrateCfg.healthCheckUrl !== undefined) {
      pollHealthCheck(calibrateCfg.healthCheckUrl, calibrateCfg.healthCheckTimeoutMs ?? 30000);
    }
  }

  let runId: string | undefined;
  try {
    // Step 4: run BugHunter
    await runCommand({ projectDir: appPath });
    runId = latestRunId(appPath);

    // Step 5: read clusters
    const clusters = readClusters(appPath, runId);

    // Step 6: match
    const { outcomes, ambiguities } = matchClustersToGold(clusters, goldEntries);

    if (ambiguities.length > 0) {
      const msgs = ambiguities.map(a => `  ${a.goldId}: candidates = ${a.candidates.join(', ')}`).join('\n');
      throw new CalibrateGoldError(
        `Structural match ambiguity — tighten normalizedLocation or normalizedMessage for:\n${msgs}`,
      );
    }

    // --record-identities
    if (opts.recordIdentities === true) {
      const updates = extractIdentityUpdates(outcomes, clusters, goldEntries);
      const conflicting = updates.filter(u => u.oldIdentity !== undefined && u.oldIdentity !== u.newIdentity);
      if (conflicting.length > 0 && opts.force !== true) {
        const msgs = conflicting.map(u => `  ${u.goldId}: existing=${u.oldIdentity} new=${u.newIdentity}`).join('\n');
        throw new CalibrateGoldError(
          `--record-identities would overwrite existing bugIdentity values. Use --force to allow:\n${msgs}`,
        );
      }
      const result = recordIdentitiesInGold(goldPath, updates);
      if (result.changed) {
        process.stdout.write(`[calibrate] Recorded ${result.updatedLines} bugIdentity value(s):\n${result.diff}\n`);
      } else {
        process.stdout.write('[calibrate] --record-identities: no new structural matches to record.\n');
      }
    }

    // Step 7: aggregate report
    const thresholds = loadThresholds(opts.thresholdsPath);
    const runDir = runPaths(appPath, runId).runDir;
    const report = aggregateReport(
      {
        outcomes,
        registry: DETECTOR_REGISTRY,
        thresholds,
        benchAppId: path.basename(appPath),
        benchVersion,
        bughunterVersion: '0.44.0',
        bughunterCommit: resolveGitCommit(),
        underlyingRunId: runId,
        underlyingRunDir: runDir,
        totalClusters: clusters.length,
        totalGoldEntries: goldEntries.length,
      },
      opts.enforceThresholds === true,
    );

    // Step 8: write report
    const outDir = opts.outPath ?? path.join(appPath, '.bughunter', 'calibration', new Date().toISOString().slice(0, 10));
    fs.mkdirSync(outDir, { recursive: true });
    const reportPath = path.join(outDir, 'calibration-report.json');
    writeJsonFile(reportPath, report);

    process.stdout.write(`${formatSummaryLine(report)}\n`);
    process.stdout.write(`[calibrate] Report written to ${reportPath}\n`);

    if (opts.jsonOutput === true) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }

    if (opts.enforceThresholds === true && report.thresholdViolations.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    // Step 9: teardown (always, even on error)
    if (!opts.noBootTeardown && calibrateCfg?.teardownScript !== undefined) {
      try {
        runScript(calibrateCfg.teardownScript, appPath, 'teardown');
      } catch (e) {
        process.stderr.write(`[calibrate] Teardown warning: ${e instanceof Error ? e.message : String(e)}\n`);
      }
    }
  }
}
