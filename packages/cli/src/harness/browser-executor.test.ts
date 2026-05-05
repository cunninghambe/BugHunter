// Unit tests for runBrowserHarness — V56.4.1 ships dormant; these tests
// validate the runner end-to-end against a mocked BrowserMcpAdapter.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runBrowserHarness, BOOTSTRAP_INSTALL_SCRIPT, HARVEST_SCRIPT } from './browser-executor.js';
import type { DetectorContract } from '../detectors/contracts.js';
import type {
  BrowserMcpAdapter, EvaluateResult, NavigateResult, ExtraHeaders, TabScope,
} from '../adapters/browser-mcp.js';

// -- Test fixture builder --------------------------------------------------

let fixtureDir: string;

beforeEach(() => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-harness-test-'));
  // Two routes in expected-clusters.jsonl so the runner has something to probe.
  fs.writeFileSync(path.join(fixtureDir, 'expected-clusters.jsonl'),
    '{"kind":"console_error","expect":"fires","minClusterSize":1,"match":{"page":"/boom"},"severity":"major"}\n'
    + '{"kind":"console_error","expect":"silent","reason":"clean page","match":{"page":"/clean"}}\n'
    + '{"kind":"console_error","expect":"skipped","reason":"no_response"}\n');
});

afterEach(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
});

function makeContract(): DetectorContract {
  return {
    kind: 'console_error',
    requires: {
      phases: ['validate', 'execute', 'classify', 'cluster'],
      tools: ['browser-mcp'],
      surface: 'web',
      role: { kind: 'none' },
      pageContext: { kind: 'any-route' },
      observationWindowMs: 50,
    },
    fixture: {
      path: 'console-error-mini',
      servesKinds: ['console_error'],
    },
    defaultBudgetMs: 10_000,
    note: 'V56.4.1 test contract',
  };
}

// -- Mock adapter that records script invocations and returns fixed responses

type ProbeRecord = { url: string; scripts: string[] };

function makeAdapter(opts: {
  envelopes: Map<string, unknown>;
  failOnNavigate?: boolean;
  installEvaluateThrows?: boolean;
}): { adapter: BrowserMcpAdapter; probes: ProbeRecord[] } {
  const probes: ProbeRecord[] = [];

  const noop = (): never => { throw new Error('not implemented in test mock'); };

  const makeScope = (url: string, tabId: string): TabScope => {
    const probe: ProbeRecord = { url, scripts: [] };
    probes.push(probe);
    const scope: TabScope = {
      tabId,
      navigate: () => Promise.resolve({ url, title: 'mock' }) as Promise<NavigateResult>,
      click: noop as TabScope['click'],
      type: noop as TabScope['type'],
      scroll: noop as TabScope['scroll'],
      snapshot: noop as TabScope['snapshot'],
      screenshot: noop as TabScope['screenshot'],
      evaluate: (script: string): Promise<EvaluateResult> => {
        probe.scripts.push(script);
        if (opts.installEvaluateThrows === true && script === BOOTSTRAP_INSTALL_SCRIPT) {
          return Promise.reject(new Error('mock: install evaluate threw'));
        }
        if (script === BOOTSTRAP_INSTALL_SCRIPT) {
          return Promise.resolve({ value: { ok: true, installed: true } });
        }
        if (script === HARVEST_SCRIPT) {
          // Map the URL pathname back to the route the runner asked for.
          const route = new URL(url).pathname;
          const envelope = opts.envelopes.get(route);
          return Promise.resolve({ value: envelope ?? null });
        }
        return Promise.resolve({ value: null });
      },
      clickByHint: noop as TabScope['clickByHint'],
    };
    return scope;
  };

  const adapter: BrowserMcpAdapter = {
    navigate: () => Promise.resolve({ url: '', title: 'mock' }) as Promise<NavigateResult>,
    click: noop as BrowserMcpAdapter['click'],
    type: noop as BrowserMcpAdapter['type'],
    scroll: noop as BrowserMcpAdapter['scroll'],
    snapshot: noop as BrowserMcpAdapter['snapshot'],
    screenshot: noop as BrowserMcpAdapter['screenshot'],
    evaluate: noop as BrowserMcpAdapter['evaluate'],
    listTabs: noop as BrowserMcpAdapter['listTabs'],
    closeTab: noop as BrowserMcpAdapter['closeTab'],
    openTab: noop as BrowserMcpAdapter['openTab'],
    closeTabExplicit: noop as BrowserMcpAdapter['closeTabExplicit'],
    cookies: noop as BrowserMcpAdapter['cookies'],
    clickByHint: noop as BrowserMcpAdapter['clickByHint'],
    withTab: async <T>(url: string, _hdrs: ExtraHeaders | undefined, fn: (scope: TabScope) => Promise<T>): Promise<T> => {
      if (opts.failOnNavigate === true) {
        throw new Error('mock: navigate failed');
      }
      const scope = makeScope(url, `tab-${probes.length}`);
      return fn(scope);
    },
  };

  return { adapter, probes };
}

// -- Tests -----------------------------------------------------------------

describe('runBrowserHarness', () => {
  it('happy path — probes every route and records envelopes', async () => {
    const envelopes = new Map<string, unknown>();
    envelopes.set('/boom', {
      consoleEvents: [{ level: 'error', message: 'boom!' }],
      uncaughtErrors: [],
      unhandledRejections: [],
      performanceEntries: [],
      resourceRequests: [],
      domState: { activeElementTag: 'BODY', bodyTextLength: 5, bodyTextSample: 'boom' },
      harvestWarnings: [],
    });
    envelopes.set('/clean', {
      consoleEvents: [],
      uncaughtErrors: [],
      unhandledRejections: [],
      performanceEntries: [],
      resourceRequests: [],
      domState: { activeElementTag: 'BODY', bodyTextLength: 5, bodyTextSample: 'clean' },
      harvestWarnings: [],
    });
    const { adapter, probes } = makeAdapter({ envelopes });

    const result = await runBrowserHarness({
      contract: makeContract(),
      target: { appBaseUrl: 'http://127.0.0.1:9999', fixturePath: fixtureDir },
      browser: adapter,
      budgetMs: 5000,
    });

    expect(result.skipReason).toBeUndefined();
    expect(result.envelopesByRoute.size).toBe(2);
    expect(result.envelopesByRoute.get('/boom')?.consoleEvents).toHaveLength(1);
    expect(result.envelopesByRoute.get('/clean')?.consoleEvents).toHaveLength(0);
    expect(probes).toHaveLength(2);
    // Each probe ran install + harvest.
    expect(probes[0]?.scripts).toEqual([BOOTSTRAP_INSTALL_SCRIPT, HARVEST_SCRIPT]);
    // Phases all ran
    expect(result.phasesRun).toEqual(['validate', 'execute', 'classify', 'cluster']);
  });

  it('tab failure on navigate yields skipReason camofox_tab_failure', async () => {
    const { adapter } = makeAdapter({ envelopes: new Map(), failOnNavigate: true });

    const result = await runBrowserHarness({
      contract: makeContract(),
      target: { appBaseUrl: 'http://127.0.0.1:9999', fixturePath: fixtureDir },
      browser: adapter,
      budgetMs: 5000,
    });

    expect(result.skipReason).toBe('camofox_tab_failure');
    expect(result.envelopesByRoute.size).toBe(0);
    expect(result.warnings.some(w => w.includes('withTab threw'))).toBe(true);
  });

  it('install-evaluate failure is reported as camofox_tab_failure for that route', async () => {
    const { adapter } = makeAdapter({ envelopes: new Map(), installEvaluateThrows: true });

    const result = await runBrowserHarness({
      contract: makeContract(),
      target: { appBaseUrl: 'http://127.0.0.1:9999', fixturePath: fixtureDir },
      browser: adapter,
      budgetMs: 5000,
    });

    expect(result.skipReason).toBe('camofox_tab_failure');
    expect(result.envelopesByRoute.size).toBe(0);
  });

  it('malformed envelope is normalised, not crashed', async () => {
    const envelopes = new Map<string, unknown>();
    envelopes.set('/boom', null); // returned non-object
    envelopes.set('/clean', { consoleEvents: 'not-an-array' }); // wrong types
    const { adapter } = makeAdapter({ envelopes });

    const result = await runBrowserHarness({
      contract: makeContract(),
      target: { appBaseUrl: 'http://127.0.0.1:9999', fixturePath: fixtureDir },
      browser: adapter,
      budgetMs: 5000,
    });

    expect(result.envelopesByRoute.size).toBe(2);
    const boom = result.envelopesByRoute.get('/boom');
    expect(boom?.consoleEvents).toEqual([]);
    expect(boom?.harvestWarnings).toContain('harvest_returned_non_object');
    const clean = result.envelopesByRoute.get('/clean');
    // wrong-type 'consoleEvents' string is coerced to []
    expect(clean?.consoleEvents).toEqual([]);
  });

  it('observationWindowMs is capped at defaultBudgetMs / 4', async () => {
    const envelopes = new Map<string, unknown>();
    envelopes.set('/boom', {
      consoleEvents: [], uncaughtErrors: [], unhandledRejections: [],
      performanceEntries: [], resourceRequests: [],
      domState: { activeElementTag: null, bodyTextLength: 0, bodyTextSample: '' },
      harvestWarnings: [],
    });
    envelopes.set('/clean', {
      consoleEvents: [], uncaughtErrors: [], unhandledRejections: [],
      performanceEntries: [], resourceRequests: [],
      domState: { activeElementTag: null, bodyTextLength: 0, bodyTextSample: '' },
      harvestWarnings: [],
    });
    const contract = makeContract();
    contract.requires.observationWindowMs = 60_000; // ridiculous value
    contract.defaultBudgetMs = 4_000;                // cap = 1000ms
    const { adapter } = makeAdapter({ envelopes });
    const start = Date.now();

    const result = await runBrowserHarness({
      contract,
      target: { appBaseUrl: 'http://127.0.0.1:9999', fixturePath: fixtureDir },
      browser: adapter,
      budgetMs: 5_000,
      observationWindowMsOverride: 1000, // explicit override matches the cap behaviour
    });

    const elapsed = Date.now() - start;
    // Two routes × ~1000ms settle each = ~2000ms. Allow generous bounds.
    expect(elapsed).toBeLessThan(4500);
    expect(result.envelopesByRoute.size).toBe(2);
  });

  it('empty fixture (no expected-clusters.jsonl) emits a warning', async () => {
    fs.unlinkSync(path.join(fixtureDir, 'expected-clusters.jsonl'));
    const { adapter } = makeAdapter({ envelopes: new Map() });

    const result = await runBrowserHarness({
      contract: makeContract(),
      target: { appBaseUrl: 'http://127.0.0.1:9999', fixturePath: fixtureDir },
      browser: adapter,
      budgetMs: 5000,
    });

    expect(result.envelopesByRoute.size).toBe(0);
    expect(result.warnings.some(w => w.includes('no probe routes loaded'))).toBe(true);
    expect(result.skipReason).toBeUndefined();
  });
});
