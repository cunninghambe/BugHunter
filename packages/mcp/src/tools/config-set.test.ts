import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getToolHandler } from '../test-utils.js';

const VALID_CONFIG = {
  projectName: 'test',
  surfaceMcpUrl: 'http://localhost:3100',
};

function makeProject(config = VALID_CONFIG): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-cfgset-'));
  fs.mkdirSync(path.join(dir, '.bughunter'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.bughunter', 'config.json'), JSON.stringify(config, null, 2));
  return dir;
}

describe('bughunt_config_set', () => {
  let projectDir = '';
  let server: McpServer;

  beforeEach(async () => {
    projectDir = makeProject();
    server = new McpServer({ name: 'test', version: '0.0.0' });
    const { registerConfigSetTool } = await import('./config-set.js');
    registerConfigSetTool(server);
  });

  afterEach(() => {
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('patches a top-level field and writes valid config', async () => {
    const handler = getToolHandler(server, 'bughunt_config_set');
    const result = await handler({ project: projectDir, key: 'maxBugs', value: 50 }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean; validated: boolean };
    expect(data.ok).toBe(true);
    expect(data.validated).toBe(true);

    const config = JSON.parse(fs.readFileSync(path.join(projectDir, '.bughunter', 'config.json'), 'utf-8')) as { maxBugs: number };
    expect(config.maxBugs).toBe(50);
  });

  it('returns errors and leaves file unchanged for invalid value (AC-6, EC-C1)', async () => {
    const original = fs.readFileSync(path.join(projectDir, '.bughunter', 'config.json'), 'utf-8');
    const handler = getToolHandler(server, 'bughunt_config_set');
    const result = await handler({ project: projectDir, key: 'maxBugs', value: -1 }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean; validated: boolean; errors?: unknown[] };
    expect(data.ok).toBe(false);
    expect(data.validated).toBe(false);
    expect(data.errors).toBeTruthy();

    // File must be byte-identical (AC-6)
    expect(fs.readFileSync(path.join(projectDir, '.bughunter', 'config.json'), 'utf-8')).toBe(original);
  });

  it('patches nested field (EC-C2)', async () => {
    const handler = getToolHandler(server, 'bughunt_config_set');
    const result = await handler({ project: projectDir, key: 'crawl.enabled', value: true }) as { content: [{ text: string }] };
    const data = JSON.parse(result.content[0].text) as { ok: boolean };
    expect(data.ok).toBe(true);

    const config = JSON.parse(fs.readFileSync(path.join(projectDir, '.bughunter', 'config.json'), 'utf-8')) as { crawl: { enabled: boolean } };
    expect(config.crawl.enabled).toBe(true);
  });

  it('patches roles array index', async () => {
    const handler = getToolHandler(server, 'bughunt_config_set');
    await handler({ project: projectDir, key: 'roles', value: ['admin', 'user'] });
    await handler({ project: projectDir, key: 'roles.0', value: 'superadmin' });
    const config = JSON.parse(fs.readFileSync(path.join(projectDir, '.bughunter', 'config.json'), 'utf-8')) as { roles: string[] };
    expect(config.roles[0]).toBe('superadmin');
  });

  it('returns error when config.json missing', async () => {
    fs.rmSync(path.join(projectDir, '.bughunter', 'config.json'));
    const handler = getToolHandler(server, 'bughunt_config_set');
    const result = await handler({ project: projectDir, key: 'maxBugs', value: 10 }) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});
