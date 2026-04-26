import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BugCluster, OccurrenceFull, ToolMeta } from '../src/types.js';
import type { SurfaceMcpAdapter } from '../src/adapters/surface-mcp.js';
import type { ActionLog } from '../src/repro/action-log.js';
import { hashSchema } from '../src/util/hash.js';

// --- module mocks ---

vi.mock('../src/store/filesystem.js', () => ({
  runPaths: (_projectDir: string, runId: string) => ({
    actionLogsDir: `/tmp/bughunter-test/${runId}/action-logs`,
  }),
}));

vi.mock('../src/repro/action-log.js', () => ({
  readActionLog: vi.fn(),
}));

vi.mock('../src/repro/replay.js', () => ({
  replayActionLog: vi.fn(),
}));

import { readActionLog } from '../src/repro/action-log.js';
import { replayActionLog } from '../src/repro/replay.js';
import { replayCluster } from '../src/ops/retest.js';

// --- helpers ---

const oldSchema: ToolMeta['inputSchema'] = {
  type: 'object',
  properties: {
    name: { type: 'string' },
  },
  required: ['name'],
};

const newSchema: ToolMeta['inputSchema'] = {
  type: 'object',
  properties: {
    name: { type: 'string' },
    email: { type: 'string', format: 'email' },
  },
  required: ['name', 'email'],
};

function makeToolMeta(toolId: string, schema: ToolMeta['inputSchema']): ToolMeta {
  return {
    name: toolId,
    toolId,
    method: 'POST',
    path: `/api/${toolId}`,
    inputSchema: schema,
    inputSchemaConfidence: 'introspected',
    sideEffectClass: 'mutating',
    sourceFile: 'src/api/route.ts',
    sourceLine: 1,
    isServerAction: false,
  };
}

function makeOccurrence(toolId: string): OccurrenceFull {
  return {
    occurrenceId: `occ-${toolId}`,
    role: 'owner',
    page: `/api/${toolId}`,
    action: {
      kind: 'api_call',
      via: 'api',
      expectedOutcome: 'expected_failure',
      palette: 'edge',
      toolId,
      input: { name: 'test' },
    },
    preState: { url: `/api/${toolId}`, title: '', consoleErrorCount: 0 },
    postState: {
      url: `/api/${toolId}`,
      title: '',
      consoleErrors: [],
      networkRequests: [],
      domErrorTextDetected: false,
      mutationObserverWindowMs: 0,
    },
    fullArtifacts: true,
    screenshotPath: '',
    domSnapshotPath: '',
    consoleLogPath: '',
    networkLogPath: '',
    actionLogPath: '',
    reproSteps: [],
    replayCommand: '',
  };
}

function makeCluster(occurrences: OccurrenceFull[]): BugCluster {
  return {
    id: 'cluster-1',
    runId: 'run-1',
    kind: 'surface_call_failed',
    rootCause: 'validation error',
    firstSeenAt: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
    clusterSize: occurrences.length,
    occurrences,
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
  };
}

function makeActionLog(toolId: string, schemaHash: string | undefined, palette: string): ActionLog {
  return {
    occurrenceId: `occ-${toolId}`,
    runId: 'run-1',
    role: 'owner',
    page: `/api/${toolId}`,
    baseUrl: `/api/${toolId}`,
    actions: [
      {
        step: 0,
        kind: 'api_call',
        toolId,
        palette,
        input: { name: 'test' },
        inputSchemaHash: schemaHash,
        timestamp: new Date().toISOString(),
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

function mockSurface(tools: ToolMeta[]): SurfaceMcpAdapter {
  return {
    surface_list_tools: vi.fn().mockResolvedValue({ revision: 2, tools }),
    surface_describe_tool: vi.fn(),
    surface_call: vi.fn(),
    surface_probe: vi.fn(),
    surface_sample_inputs: vi.fn(),
    surface_login_status: vi.fn(),
    surface_relogin: vi.fn(),
    surface_routes_for_page: vi.fn(),
  };
}

const ACTION_LOGS_DIR = '/tmp/bughunter-test/run-1/action-logs';

// --- tests ---

beforeEach(() => {
  vi.clearAllMocks();
});

describe('replayCluster — schema unchanged', () => {
  it('replays input verbatim when inputSchemaHash matches post-fix schema', async () => {
    const toolId = 'tool-unchanged';
    const schema = oldSchema;
    const schemaHash = hashSchema(schema);

    vi.mocked(readActionLog).mockReturnValue(makeActionLog(toolId, schemaHash, 'edge'));
    vi.mocked(replayActionLog).mockResolvedValue({
      ok: true,
      observation: { consoleErrors: [], networkRequests: [] },
    });

    const surface = mockSurface([makeToolMeta(toolId, schema)]);
    const cluster = makeCluster([makeOccurrence(toolId)]);

    const result = await replayCluster(cluster, ACTION_LOGS_DIR, surface);

    expect(result.verdict).toBe('verified_fixed');
    expect(result.passedOccurrences).toBe(1);

    // The action log passed to replayActionLog should still carry { name: 'test' } — verbatim
    const passedLog = vi.mocked(replayActionLog).mock.calls[0][0] as ActionLog;
    expect(passedLog.actions[0].input).toEqual({ name: 'test' });
  });
});

describe('replayCluster — schema changed', () => {
  it('regenerates input with same palette when inputSchema changed after fix', async () => {
    const toolId = 'tool-changed';
    // The action log was written against oldSchema
    const originalHash = hashSchema(oldSchema);

    vi.mocked(readActionLog).mockReturnValue(makeActionLog(toolId, originalHash, 'edge'));
    vi.mocked(replayActionLog).mockResolvedValue({
      ok: true,
      observation: { consoleErrors: [], networkRequests: [] },
    });

    // Post-fix catalog returns newSchema (which adds 'email' field)
    const surface = mockSurface([makeToolMeta(toolId, newSchema)]);
    const cluster = makeCluster([makeOccurrence(toolId)]);

    await replayCluster(cluster, ACTION_LOGS_DIR, surface);

    const passedLog = vi.mocked(replayActionLog).mock.calls[0][0] as ActionLog;
    const passedInput = passedLog.actions[0].input as Record<string, unknown>;

    // Regenerated input must contain both fields from newSchema
    expect(passedInput).toHaveProperty('name');
    expect(passedInput).toHaveProperty('email');
    // Must NOT be the original verbatim input (which only had 'name')
    expect(Object.keys(passedInput)).toContain('email');
  });

  it('uses the correct palette (edge) when regenerating input after schema change', async () => {
    const toolId = 'tool-palette';
    const originalHash = hashSchema(oldSchema);

    // palette is 'edge' in the stored action log
    vi.mocked(readActionLog).mockReturnValue(makeActionLog(toolId, originalHash, 'edge'));
    vi.mocked(replayActionLog).mockResolvedValue({
      ok: true,
      observation: { consoleErrors: [], networkRequests: [] },
    });

    const surface = mockSurface([makeToolMeta(toolId, newSchema)]);
    const cluster = makeCluster([makeOccurrence(toolId)]);

    await replayCluster(cluster, ACTION_LOGS_DIR, surface);

    // We can verify the palette was 'edge' by confirming the action log entry's palette is intact
    const passedLog = vi.mocked(replayActionLog).mock.calls[0][0] as ActionLog;
    expect(passedLog.actions[0].palette).toBe('edge');
  });
});

describe('replayCluster — tool removed entirely', () => {
  it('returns verified_fixed_by_removal when the tool no longer exists in the catalog', async () => {
    const toolId = 'tool-removed';

    const surface = mockSurface([]); // empty catalog — tool gone
    const cluster = makeCluster([makeOccurrence(toolId)]);

    const result = await replayCluster(cluster, ACTION_LOGS_DIR, surface);

    expect(result.verdict).toBe('verified_fixed_by_removal');
    expect(result.passedOccurrences).toBe(1);
    // readActionLog and replayActionLog should never be called for removed tools
    expect(readActionLog).not.toHaveBeenCalled();
    expect(replayActionLog).not.toHaveBeenCalled();
  });
});
