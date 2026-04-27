import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const FIXTURE_SOURCE = '/root/SurfaceMCP/fixtures/nextjs-app';

/**
 * Copies the SurfaceMCP fixture Next.js app into a fresh temp directory.
 * Excludes the `.bughunter/` directory so pre-existing run artifacts from the
 * source fixture don't pollute the e2e test's run reads.
 * Returns the path of the temp directory. The caller is responsible for
 * removing it on teardown.
 */
export function copyFixtureToTemp(): string {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-e2e-fixture-'));
  fs.cpSync(FIXTURE_SOURCE, dest, {
    recursive: true,
    filter: (src) => !src.includes(`${path.sep}.bughunter`),
  });
  return dest;
}

/**
 * Writes surfacemcp.config.json into the fixture dir pointing at the given
 * Next.js base URL and SurfaceMCP port. Overwrites whatever the fixture ships.
 */
export function writeSurfaceMcpConfig(fixtureDir: string, appBaseUrl: string, surfaceMcpPort: number): void {
  const config = {
    surfaces: [
      {
        name: 'web',
        stack: 'nextjs',
        root: '.',
        baseUrl: appBaseUrl,
        port: surfaceMcpPort,
        watchPaths: ['app', 'pages', 'src'],
        watchIgnore: [],
        auth: { kind: 'none' },
        roles: [{ name: 'anonymous', credentials: {} }],
        excludedRoutes: [],
        externalIntegrations: [],
        _suggestedExternalIntegrations: [],
      },
    ],
  };
  fs.writeFileSync(
    path.join(fixtureDir, 'surfacemcp.config.json'),
    JSON.stringify(config, null, 2) + '\n'
  );
}

/**
 * Writes .bughunter/config.json in the given projectDir.
 * browserMcpUrl is optional — omit for API-only runs.
 */
export function writeBugHunterConfig(
  projectDir: string,
  opts: {
    surfaceMcpUrl: string;
    appBaseUrl: string;
    browserMcpUrl?: string;
    bodyFixtures?: Record<string, Record<string, Record<string, unknown>>>;
  }
): void {
  const configDir = path.join(projectDir, '.bughunter');
  fs.mkdirSync(configDir, { recursive: true });
  const config: Record<string, unknown> = {
    projectName: 'e2e-fixture',
    surfaceMcpUrl: opts.surfaceMcpUrl,
    appBaseUrl: opts.appBaseUrl,
    maxBugs: 50,
    maxRuntimeMs: 60000,
  };
  if (opts.browserMcpUrl) config['browserMcpUrl'] = opts.browserMcpUrl;
  if (opts.bodyFixtures) config['bodyFixtures'] = opts.bodyFixtures;
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(config, null, 2) + '\n'
  );
}
