/**
 * BugHunter cross-repo e2e harness.
 *
 * Spawns the SurfaceMCP fixture Next.js app and SurfaceMCP server, then runs
 * BugHunter against them. All BugHunter runs use fixtureDir as projectDir so
 * the filesystem page discovery finds app/dom-test/page.tsx for UI tests.
 *
 * Test 1 (API-only): always runs. Asserts tool discovery, surface_call_failed
 * clustering, relatedClusterIds (Gap 1.A regression gate).
 *
 * Test 2 (browser, conditional): runs only when camofox-mcp is reachable at
 * http://127.0.0.1:3104. Asserts mutationObserverWindowMs > 0 (Gap 1.B gate).
 *
 * Test 3 (bodyFixtures suppression): re-runs API-only with bodyFixtures seeding
 * the journal-entries tool; asserts the previously-flagged network_5xx cluster
 * disappears.
 *
 * Skip-when-camofox-down: prints a [skip] line and exits 0 for browser tests.
 * All spawned processes are killed in afterAll regardless of test outcome.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { getFreePort, getFreePortInRange } from './helpers/free-port.js';
import {
  copyFixtureToTemp,
  copyViteAppFixtureToTemp,
  copyViteCrawlAppFixtureToTemp,
  writeSurfaceMcpConfig,
  writeSurfaceMcpConfigForVite,
  writeSurfaceMcpConfigForViteCrawl,
  writeBugHunterConfig,
} from './helpers/fixture-project.js';
import {
  startNextDev,
  startSurfaceMcp,
  startViteDev,
  waitForUrl,
  runBugHunter,
  kill,
} from './helpers/spawn.js';
import { discoverFilesystemPages } from '../../src/discovery/filesystem-pages.js';
import { discoverPages } from '../../src/discovery/pages.js';
import { HttpSurfaceMcpAdapter } from '../../src/adapters/surface-mcp.js';
import type { BugCluster, OccurrenceFull } from '../../src/types.js';
import type { ChildProcess } from 'node:child_process';

const CAMOFOX_URL = 'http://127.0.0.1:3104';

let fixtureDir: string;
let nextProc: ChildProcess | null = null;
let surfaceProc: ChildProcess | null = null;
let appPort: number;
let surfacePort: number;
let appBaseUrl: string;
let surfaceMcpUrl: string;
let browserAvailable = false;

async function checkCamofox(): Promise<boolean> {
  try {
    const res = await fetch(`${CAMOFOX_URL}/health`, { signal: AbortSignal.timeout(3_000) });
    return res.ok;
  } catch {
    return false;
  }
}

function readBugsForRun(runId: string): BugCluster[] {
  const bugsFile = path.join(fixtureDir, '.bughunter', 'runs', runId, 'bugs.jsonl');
  if (!fs.existsSync(bugsFile)) return [];
  return fs.readFileSync(bugsFile, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as BugCluster);
}

function readSummaryForRun(runId: string): Record<string, unknown> | null {
  const summaryFile = path.join(fixtureDir, '.bughunter', 'runs', runId, 'summary.json');
  if (!fs.existsSync(summaryFile)) return null;
  return JSON.parse(fs.readFileSync(summaryFile, 'utf-8')) as Record<string, unknown>;
}

/** Saved clusters from the API-only run for cross-test assertions. */
let apiRunClusters: BugCluster[] = [];

beforeAll(async () => {
  // Copy fixture to an isolated temp dir, excluding any pre-existing .bughunter/ artifacts.
  // All BugHunter runs use this dir as projectDir so filesystem discovery finds app/.
  fixtureDir = copyFixtureToTemp();

  // Allocate ports
  appPort = await getFreePort();
  surfacePort = await getFreePortInRange(3103, 3199); // 3102 may be in use by production SurfaceMCP
  appBaseUrl = `http://127.0.0.1:${appPort}`;
  surfaceMcpUrl = `http://127.0.0.1:${surfacePort}/mcp`;

  // Write surfacemcp.config.json pointing at the fixture app
  writeSurfaceMcpConfig(fixtureDir, appBaseUrl, surfacePort);

  // Spawn Next.js dev server using the fixture's npm run dev script
  nextProc = startNextDev(fixtureDir, appPort);

  // Spawn SurfaceMCP against the fixture dir
  surfaceProc = startSurfaceMcp(fixtureDir);

  // Wait for both to be reachable
  const [nextReady, surfaceReady] = await Promise.all([
    waitForUrl(appBaseUrl, 60_000),
    waitForUrl(`http://127.0.0.1:${surfacePort}/health`, 30_000),
  ]);

  if (!nextReady) throw new Error(`Next.js dev server did not start on ${appBaseUrl}`);
  if (!surfaceReady) throw new Error(`SurfaceMCP did not start on port ${surfacePort}`);

  // Check camofox availability
  browserAvailable = await checkCamofox();
  if (!browserAvailable) {
    process.stdout.write(
      `[skip] camofox-mcp daemon not running on ${CAMOFOX_URL}; browser portion of e2e skipped\n`
    );
  }
}, 120_000);

afterAll(async () => {
  if (nextProc) await kill(nextProc);
  if (surfaceProc) await kill(surfaceProc);
  // Clean up temp fixture dir (best-effort — includes .bughunter/ run artifacts)
  try { if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true }); } catch {}
}, 60_000);

describe('BugHunter e2e — API-only', () => {
  it('completes a full run and produces a summary with tests planned', async () => {
    // fixtureDir is the projectDir — filesystem discovery finds app/ pages here.
    // API-only config: no browserMcpUrl.
    writeBugHunterConfig(fixtureDir, { surfaceMcpUrl, appBaseUrl });
    const { code, stdout, runId } = await runBugHunter(fixtureDir);

    expect(code, `bughunter exited ${code}:\n${stdout}`).toBe(0);
    expect(runId, `Could not parse run ID from stdout:\n${stdout}`).toBeDefined();

    const summary = readSummaryForRun(runId!);
    expect(summary, 'No summary.json produced').not.toBeNull();
    expect(
      (summary as Record<string, unknown>)['testsPlanned'],
      `summary.json keys: ${Object.keys(summary as object).join(', ')}`
    ).toBeGreaterThan(0);

    // Save clusters for subsequent assertions in this test block
    apiRunClusters = readBugsForRun(runId!);
  }, 90_000);

  it('conditional-404 route triggers surface_call_failed cluster', () => {
    const failedCluster = apiRunClusters.find(c => c.kind === 'surface_call_failed');
    expect(failedCluster, 'Expected at least one surface_call_failed cluster').toBeDefined();
  });

  it('discoverPages dispatch returns identical pages for the Next.js fixture (§ 6.5)', async () => {
    const adapter = new HttpSurfaceMcpAdapter(surfaceMcpUrl);
    const before = await discoverFilesystemPages(fixtureDir);
    const after = await discoverPages(fixtureDir, adapter);
    const beforeSet = new Set(before.map(p => p.route));
    const afterSet = new Set(after.map(p => p.route));
    expect([...afterSet].sort()).toEqual([...beforeSet].sort());
  }, 30_000);

  it('relatedClusterIds links 404_for_linked_route ↔ surface_call_failed (Gap 1.A)', () => {
    const cluster404 = apiRunClusters.find(c => c.kind === '404_for_linked_route');
    const clusterFailed = apiRunClusters.find(c => c.kind === 'surface_call_failed');

    const kindsSeen = apiRunClusters.map(c => c.kind).join(', ') || '(none)';
    expect(
      cluster404,
      `Expected a 404_for_linked_route cluster. Kinds seen: ${kindsSeen}`
    ).toBeDefined();
    expect(
      clusterFailed,
      `Expected a surface_call_failed cluster. Kinds seen: ${kindsSeen}`
    ).toBeDefined();

    const hasLink =
      cluster404!.relatedClusterIds?.includes(clusterFailed!.id) ||
      clusterFailed!.relatedClusterIds?.includes(cluster404!.id);
    expect(hasLink, 'Expected mutual relatedClusterIds link between 404_for_linked_route and surface_call_failed').toBe(true);
  });
});

describe('BugHunter e2e — browser (conditional on camofox)', () => {
  it('dom-test click produces mutationObserverWindowMs > 0 (Gap 1.B)', async () => {
    if (!browserAvailable) {
      process.stdout.write('[skip] camofox unavailable — browser e2e skipped\n');
      return;
    }

    // Run BugHunter with browser against the fixture dir (fixtureDir has app/dom-test/page.tsx)
    writeBugHunterConfig(fixtureDir, {
      surfaceMcpUrl,
      appBaseUrl,
      browserMcpUrl: CAMOFOX_URL,
    });

    const { code, stdout, runId } = await runBugHunter(fixtureDir);
    expect(code, `bughunter (browser) exited ${code}:\n${stdout}`).toBe(0);
    expect(runId, `Could not parse run ID:\n${stdout}`).toBeDefined();

    const bugs = readBugsForRun(runId!);

    expect(
      bugs.some(c => c.occurrences.some(o => o.action.via === 'ui')),
      `Expected at least one UI cluster. Total clusters: ${bugs.length}. ` +
      `Kinds: ${bugs.map(c => c.kind).join(', ') || '(none)'}.\n` +
      `stdout: ${stdout.slice(0, 800)}`
    ).toBe(true);

    let maxMutMs = 0;
    for (const cluster of bugs) {
      for (const occ of cluster.occurrences) {
        if (occ.fullArtifacts && occ.action.via === 'ui') {
          const ms = (occ as OccurrenceFull).postState.mutationObserverWindowMs;
          if (ms > maxMutMs) maxMutMs = ms;
        }
      }
    }

    expect(
      maxMutMs,
      `Expected mutationObserverWindowMs > 0 on at least one UI occurrence.\n` +
      `Total clusters: ${bugs.length}.\n` +
      `stdout: ${stdout.slice(0, 800)}`
    ).toBeGreaterThan(0);
    expect(maxMutMs).toBeLessThan(60_000);
  }, 150_000);
});

describe('BugHunter e2e — bodyFixtures suppression', () => {
  it('network_5xx cluster from journal-entries disappears when bodyFixtures seeds memo', async () => {
    // journal-entries throws when body.memo is absent → network_5xx cluster.
    // With bodyFixtures seeding { memo: 'seeded', amount: 42 }, it returns 201 → no cluster.
    //
    // We query SurfaceMCP to resolve the journal-entries toolId directly, rather than
    // inferring it from cluster data (other routes like orders also produce network_5xx).

    type SurfaceTool = { toolId: string; path: string; method: string };
    type ListResult = { tools: SurfaceTool[] };

    let journalToolId: string | undefined;
    try {
      const res = await fetch(`http://127.0.0.1:${surfacePort}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          params: { name: 'surface_list_tools', arguments: {} },
          id: 1,
        }),
      });
      // SurfaceMCP responds with text/event-stream even for single-message MCP calls.
      // Extract the JSON payload from the first `data:` line.
      const raw = await res.text();
      const dataLine = raw.split('\n').find(l => l.startsWith('data:'));
      const envelope = JSON.parse(dataLine?.slice(5).trim() ?? '{}') as { result?: { content?: Array<{ text?: string }> } };
      const text = envelope.result?.content?.[0]?.text ?? '{}';
      const data = JSON.parse(text) as ListResult;
      const journalTool = data.tools?.find(t => t.path === '/api/journal-entries' && t.method === 'POST');
      journalToolId = journalTool?.toolId;
    } catch {
      // SurfaceMCP query failed; fall back to skipping
    }

    expect(
      journalToolId,
      'Could not resolve journal-entries toolId from SurfaceMCP surface_list_tools'
    ).toBeDefined();
    if (!journalToolId) return; // unreachable — expect above would have thrown

    writeBugHunterConfig(fixtureDir, {
      surfaceMcpUrl,
      appBaseUrl,
      bodyFixtures: { [journalToolId]: { '*': { memo: 'seeded', amount: 42 } } },
    });

    // Wait for the fixture's journal-entries endpoint to stabilise with the seeded body.
    // After the API-only and browser runs, the Next.js dev server may need a moment to recover.
    // Poll for up to 20s; skip the test if it doesn't stabilise.
    let journalOk = false;
    {
      const deadline = Date.now() + 20_000;
      let lastStatus = 0;
      let lastBody = '';
      while (Date.now() < deadline) {
        try {
          const probe = await fetch(`${appBaseUrl}/api/journal-entries`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ memo: 'seeded', amount: 42 }),
            signal: AbortSignal.timeout(5_000),
          });
          lastStatus = probe.status;
          lastBody = await probe.text();
          if (probe.status === 201) { journalOk = true; break; }
        } catch (err) {
          process.stdout.write(`[debug] probe error: ${String(err)}\n`);
        }
        await new Promise(r => setTimeout(r, 2_000));
      }
      if (!journalOk) {
        expect.fail(
          `journal-entries endpoint did not stabilise within 20 s. ` +
          `Last response: ${lastStatus} ${lastBody.slice(0, 200)}`
        );
      }
    }

    const { code, stdout, runId } = await runBugHunter(fixtureDir);
    expect(code, `bughunter (suppress) exited ${code}:\n${stdout}`).toBe(0);
    expect(runId, `Could not parse run ID:\n${stdout}`).toBeDefined();

    const bugsAfter = readBugsForRun(runId!);
    // With memo+amount seeded, journal-entries returns 201 → no network_5xx for that tool
    const stillFailing = bugsAfter.find(
      c => c.kind === 'network_5xx' && c.occurrences[0]?.action.toolId === journalToolId
    );
    expect(
      stillFailing,
      `Expected network_5xx for tool ${journalToolId} (journal-entries) to be suppressed by bodyFixtures.\n` +
      `stdout: ${stdout.slice(0, 800)}`
    ).toBeUndefined();
  }, 90_000);
});

// ---------------------------------------------------------------------------
// BugHunter e2e — Vite SPA (spec § 6.4)
// ---------------------------------------------------------------------------

let viteFfixtureDir: string;
let viteSurfaceProc: ChildProcess | null = null;
let viteSurfacePort: number;
let viteSurfaceMcpUrl: string;

beforeAll(async () => {
  viteFfixtureDir = copyViteAppFixtureToTemp();
  viteSurfacePort = await getFreePortInRange(3103, 3199);
  viteSurfaceMcpUrl = `http://127.0.0.1:${viteSurfacePort}/mcp`;

  writeSurfaceMcpConfigForVite(viteFfixtureDir, viteSurfacePort);
  viteSurfaceProc = startSurfaceMcp(viteFfixtureDir);

  const ready = await waitForUrl(`http://127.0.0.1:${viteSurfacePort}/health`, 30_000);
  if (!ready) throw new Error(`SurfaceMCP (vite) did not start on port ${viteSurfacePort}`);
}, 60_000);

afterAll(async () => {
  if (viteSurfaceProc) await kill(viteSurfaceProc);
  try { if (viteFfixtureDir) fs.rmSync(viteFfixtureDir, { recursive: true, force: true }); } catch {}
}, 30_000);

describe('BugHunter e2e — Vite SPA', () => {
  it('surface_describe_self reports stack: vite and capabilities.listPages: true', async () => {
    const adapter = new HttpSurfaceMcpAdapter(viteSurfaceMcpUrl);
    const info = await adapter.surface_describe_self();
    expect(info.stack).toBe('vite');
    expect(info.capabilities.listPages).toBe(true);
  }, 15_000);

  it('surface_list_pages returns exactly the 6 MUST_DISCOVER pages', async () => {
    const adapter = new HttpSurfaceMcpAdapter(viteSurfaceMcpUrl);
    const result = await adapter.surface_list_pages();
    const routes = result.pages.map(p => p.route).sort();
    const expected = ['/', '/about', '/admin', '/admin/settings', '/admin/users', '/users/:id'];
    expect(routes).toEqual(expected);
  }, 15_000);

  it('bughunter run plans non-zero UI tests against the Vite fixture', async () => {
    // appBaseUrl points at a non-existent Vite server — that is fine because
    // no browser is configured, so no DOM walk will be attempted. The pages are
    // discovered statically via surface_list_pages.
    const appBaseUrl = `http://127.0.0.1:5199`; // unused placeholder
    writeBugHunterConfig(viteFfixtureDir, {
      surfaceMcpUrl: viteSurfaceMcpUrl,
      appBaseUrl,
      discoveryFixtures: { '/users/:id': ['42'] },
    });

    const { code, stdout, runId } = await runBugHunter(viteFfixtureDir);
    expect(code, `bughunter (vite) exited ${code}:\n${stdout}`).toBe(0);
    expect(runId, `Could not parse run ID:\n${stdout}`).toBeDefined();

    const summaryFile = path.join(viteFfixtureDir, '.bughunter', 'runs', runId!, 'summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf-8')) as Record<string, unknown>;
    expect(
      summary['testsPlanned'],
      `Expected testsPlanned > 0. summary: ${JSON.stringify(summary)}\nstdout: ${stdout.slice(0, 800)}`
    ).toBeGreaterThan(0);
  }, 90_000);

  it('/users/:id is skipped without discoveryFixtures', async () => {
    const appBaseUrl = `http://127.0.0.1:5199`;
    writeBugHunterConfig(viteFfixtureDir, {
      surfaceMcpUrl: viteSurfaceMcpUrl,
      appBaseUrl,
      // no discoveryFixtures
    });

    const { code, stdout, runId } = await runBugHunter(viteFfixtureDir);
    expect(code, `bughunter (vite no-fixture) exited ${code}:\n${stdout}`).toBe(0);
    expect(runId).toBeDefined();

    const summaryFile = path.join(viteFfixtureDir, '.bughunter', 'runs', runId!, 'summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf-8')) as Record<string, unknown>;
    const skipped = summary['skippedReasons'] as Array<{ reason: string; count: number }>;
    expect(
      skipped?.some(s => s.reason.includes('missing_fixture')),
      `Expected a missing_fixture skip entry. skippedReasons: ${JSON.stringify(skipped)}`
    ).toBe(true);
  }, 90_000);
});

// ---------------------------------------------------------------------------
// BugHunter e2e — Vite SPA crawl (no router) (spec § 5.7)
// ---------------------------------------------------------------------------

let crawlFixtureDir: string;
let crawlViteProc: ChildProcess | null = null;
let crawlSurfaceProc: ChildProcess | null = null;
let crawlAppPort: number;
let crawlSurfacePort: number;
let crawlAppBaseUrl: string;
let crawlSurfaceMcpUrl: string;

beforeAll(async () => {
  crawlFixtureDir = copyViteCrawlAppFixtureToTemp();

  // Install deps in the copied fixture (node_modules excluded from copy)
  execSync('npm install --prefer-offline --no-audit --no-fund', {
    cwd: crawlFixtureDir,
    stdio: 'ignore',
    timeout: 120_000,
  });

  crawlAppPort = await getFreePort();
  crawlSurfacePort = await getFreePortInRange(3103, 3199);
  crawlAppBaseUrl = `http://127.0.0.1:${crawlAppPort}`;
  crawlSurfaceMcpUrl = `http://127.0.0.1:${crawlSurfacePort}/mcp`;

  writeSurfaceMcpConfigForViteCrawl(crawlFixtureDir, crawlAppPort, crawlSurfacePort);

  crawlViteProc = startViteDev(crawlFixtureDir, crawlAppPort);
  crawlSurfaceProc = startSurfaceMcp(crawlFixtureDir);

  const [viteReady, surfaceReady] = await Promise.all([
    waitForUrl(crawlAppBaseUrl, 60_000),
    waitForUrl(`http://127.0.0.1:${crawlSurfacePort}/health`, 30_000),
  ]);

  if (!viteReady) throw new Error(`Vite dev server did not start on ${crawlAppBaseUrl}`);
  if (!surfaceReady) throw new Error(`SurfaceMCP (crawl) did not start on port ${crawlSurfacePort}`);
}, 180_000);

afterAll(async () => {
  if (crawlViteProc) await kill(crawlViteProc);
  if (crawlSurfaceProc) await kill(crawlSurfaceProc);
  try { if (crawlFixtureDir) fs.rmSync(crawlFixtureDir, { recursive: true, force: true }); } catch {}
}, 30_000);

describe('BugHunter e2e — Vite SPA crawl (no router)', () => {
  it('plans non-zero UI tests (case 20)', async () => {
    if (!browserAvailable) {
      process.stdout.write('[skip] camofox unavailable — crawl e2e case 20 skipped\n');
      return;
    }

    writeBugHunterConfig(crawlFixtureDir, {
      surfaceMcpUrl: crawlSurfaceMcpUrl,
      appBaseUrl: crawlAppBaseUrl,
      browserMcpUrl: CAMOFOX_URL,
    });

    const { code, stdout, runId } = await runBugHunter(crawlFixtureDir);
    expect(code, `bughunter (crawl) exited ${code}:\n${stdout}`).toBe(0);
    expect(runId, `Could not parse run ID:\n${stdout}`).toBeDefined();

    const summaryFile = path.join(crawlFixtureDir, '.bughunter', 'runs', runId!, 'summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf-8')) as Record<string, unknown>;
    expect(
      summary['testsPlanned'],
      `Expected testsPlanned > 0. summary: ${JSON.stringify(summary)}\nstdout: ${stdout.slice(0, 800)}`
    ).toBeGreaterThan(0);
  }, 180_000);

  it('all four routes appear in discovery (case 21)', async () => {
    if (!browserAvailable) {
      process.stdout.write('[skip] camofox unavailable — crawl e2e case 21 skipped\n');
      return;
    }

    writeBugHunterConfig(crawlFixtureDir, {
      surfaceMcpUrl: crawlSurfaceMcpUrl,
      appBaseUrl: crawlAppBaseUrl,
      browserMcpUrl: CAMOFOX_URL,
    });

    const { code, stdout, runId } = await runBugHunter(crawlFixtureDir);
    expect(code, `bughunter (crawl routes) exited ${code}:\n${stdout}`).toBe(0);
    expect(runId, `Could not parse run ID:\n${stdout}`).toBeDefined();

    const stateFile = path.join(crawlFixtureDir, '.bughunter', 'runs', runId!, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as { discovery?: { pages: Array<{ route: string }> } };
    const routes = (state.discovery?.pages ?? []).map(p => p.route).sort();
    expect(routes, `Expected 4 crawled routes. Got: ${JSON.stringify(routes)}\nstdout: ${stdout.slice(0, 800)}`).toEqual(['/', '/about', '/dashboard', '/login']);
  }, 180_000);

  it('maxPages cap respected (case 22)', async () => {
    if (!browserAvailable) {
      process.stdout.write('[skip] camofox unavailable — crawl e2e case 22 skipped\n');
      return;
    }

    writeBugHunterConfig(crawlFixtureDir, {
      surfaceMcpUrl: crawlSurfaceMcpUrl,
      appBaseUrl: crawlAppBaseUrl,
      browserMcpUrl: CAMOFOX_URL,
      crawl: { maxPages: 2 },
    });

    const { code, stdout, runId } = await runBugHunter(crawlFixtureDir);
    expect(code, `bughunter (crawl cap) exited ${code}:\n${stdout}`).toBe(0);
    expect(runId, `Could not parse run ID:\n${stdout}`).toBeDefined();

    const stateFile = path.join(crawlFixtureDir, '.bughunter', 'runs', runId!, 'state.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as { discovery?: { pages: Array<{ route: string }> } };
    const pages = state.discovery?.pages ?? [];
    expect(
      pages.length,
      `Expected ≤ 2 pages with maxPages=2. pages: ${JSON.stringify(pages.map(p => p.route))}\nstdout: ${stdout.slice(0, 800)}`
    ).toBeLessThanOrEqual(2);
  }, 180_000);

  it('crawl_skipped reason present in summary when off-origin links exist (case 23)', async () => {
    if (!browserAvailable) {
      process.stdout.write('[skip] camofox unavailable — crawl e2e case 23 skipped\n');
      return;
    }

    // The Landing page has an external link (https://vitejs.dev) for this assertion.
    // If no off-origin links exist in the fixture, assert the summary skippedReasons array exists.
    writeBugHunterConfig(crawlFixtureDir, {
      surfaceMcpUrl: crawlSurfaceMcpUrl,
      appBaseUrl: crawlAppBaseUrl,
      browserMcpUrl: CAMOFOX_URL,
    });

    const { code, stdout, runId } = await runBugHunter(crawlFixtureDir);
    expect(code, `bughunter (crawl skip) exited ${code}:\n${stdout}`).toBe(0);
    expect(runId, `Could not parse run ID:\n${stdout}`).toBeDefined();

    const summaryFile = path.join(crawlFixtureDir, '.bughunter', 'runs', runId!, 'summary.json');
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf-8')) as Record<string, unknown>;
    const skipped = summary['skippedReasons'] as Array<{ reason: string; count: number }> | undefined;

    // The fixture Landing page has https://vitejs.dev — an off-origin link that
    // should appear in skippedReasons as crawl_skipped: off_origin_or_unsupported.
    expect(
      skipped?.some(s => s.reason.startsWith('crawl_skipped:')),
      `Expected a crawl_skipped: entry in skippedReasons. skippedReasons: ${JSON.stringify(skipped)}\nstdout: ${stdout.slice(0, 800)}`
    ).toBe(true);
  }, 180_000);
});
