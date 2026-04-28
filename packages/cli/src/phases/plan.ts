// Phase 2: plan — schema enrichment + test plan generation + budget (§ 3.4).

import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type {
  BugHunterConfig, DiscoveredForm, DiscoveredPage, DiscoveryOutput, TestCase, ToolMeta,
} from '../types.js';
import { formTestCases, apiTestCases, xssFormTestCases, xssApiTestCases } from '../mutation/apply.js';
import { formCollapseSignature } from '../discovery/element-collapse.js';
import { log } from '../log.js';
import { createId } from '@paralleldrive/cuid2';
import { probeKey as buildProbeKey, type ProbeKey, type ProbeResult } from './form-reachability-probe.js';

export type PlanResult = {
  testCases: TestCase[];
  projectedRuntimeMs: number;
  upgradedToolIds: string[];
  skipReasons: Array<{ reason: string; count: number }>;
};

const AVG_TEST_MS = 7_500; // conservative estimate per test

export async function runPlan(
  runId: string,
  discovery: DiscoveryOutput,
  config: BugHunterConfig,
  roles: string[],
  surface: SurfaceMcpAdapter,
  probes?: Map<ProbeKey, ProbeResult>,
): Promise<PlanResult> {
  const upgradedToolIds: string[] = [];

  // Pre-plan schema enrichment: probe unknown-confidence tools
  const enrichedTools = await enrichToolSchemas(discovery.apiTools, roles[0] ?? 'anonymous', surface, upgradedToolIds);

  const testCases: TestCase[] = [];
  const seenFormSigs = new Set<string>(); // per-role, across pages
  const seenElementSigs = new Map<string, Set<string>>(); // role -> Set of sigs
  const skipReasonCounts = new Map<string, number>();

  const xssEnabled = config.xss?.enabled ?? true;
  const xssDepth = config.xss?.depth ?? 'minimal';
  const xssMaxTestCases = config.xss?.maxTestCases ?? 200;
  const xssMutateJsonBodies = config.xss?.mutateJsonBodies ?? true;
  let xssCount = 0;

  for (const role of roles) {
    seenFormSigs.clear();
    seenElementSigs.set(role, new Set());

    // Per-page tests
    for (const page of discovery.pages) {
      const pageStateCtx = page.kind === 'state' ? page.stateContext : undefined;

      // Render test (always)
      testCases.push(renderTestCase(runId, role, page.route, pageStateCtx));

      // Navigate tests per distinct link target
      const seenLinks = new Set<string>();
      for (const link of page.links) {
        if (!seenLinks.has(link)) {
          seenLinks.add(link);
          testCases.push(navigateTestCase(runId, role, page.route, link, pageStateCtx));
        }
      }

      // Click tests per collapsed element (buttons)
      const elSigs = seenElementSigs.get(role) ?? new Set<string>();
      for (const el of page.elements) {
        if (el.tag === 'button' || el.roleAttr === 'button') {
          if (!elSigs.has(el.selector)) {
            elSigs.add(el.selector);
            testCases.push(clickTestCase(runId, role, page.route, el.selector, pageStateCtx));
          }
        }
      }
      seenElementSigs.set(role, elSigs);

      // Form fill-and-submit tests (collapsed across pages)
      for (const form of page.forms) {
        const sig = formCollapseSignature(
          form.fields.map(f => f.name),
          form.fields.map(f => f.type)
        );
        if (!seenFormSigs.has(sig)) {
          seenFormSigs.add(sig);
          const { emit, skipReason } = shouldEmitSubmitTest(role, page, form, probes);
          if (!emit) {
            const reason = skipReason ?? 'form_unreachable_for_role';
            skipReasonCounts.set(reason, (skipReasonCounts.get(reason) ?? 0) + 1);
            log.debug('plan: skipping submit tests', { role, page: page.route, form: form.formSelector, skipReason: reason });
            continue;
          }
          const cases = formTestCases(runId, role, page.route, form, runId, config.domainHints, pageStateCtx);
          testCases.push(...cases);

          // XSS canary injection for this form
          if (xssEnabled && xssCount < xssMaxTestCases) {
            const xssCases = xssFormTestCases(runId, role, page.route, form, xssDepth, pageStateCtx);
            const allowed = Math.min(xssCases.length, xssMaxTestCases - xssCount);
            testCases.push(...xssCases.slice(0, allowed));
            xssCount += allowed;
          }
        }
      }
    }

    // Per-tool API tests — server actions are excluded (§ 3.4)
    for (const tool of enrichedTools) {
      if (tool.isServerAction) continue;

      const samples = await surface.surface_sample_inputs({ toolId: tool.toolId })
        .then(r => r.samples.map(s => s.input))
        .catch(() => []);

      // Resolve bodyFixture: specific role wins over wildcard
      const toolFixtures = config.bodyFixtures?.[tool.toolId];
      const bodyFixture =
        toolFixtures?.[role] ??
        toolFixtures?.['*'];

      const cases = apiTestCases(runId, role, tool, samples, config.domainHints, bodyFixture);
      testCases.push(...cases);

      // XSS canary injection for this API tool
      if (xssEnabled && xssCount < xssMaxTestCases) {
        const xssCases = xssApiTestCases(runId, role, tool, xssDepth, xssMutateJsonBodies);
        const allowed = Math.min(xssCases.length, xssMaxTestCases - xssCount);
        testCases.push(...xssCases.slice(0, allowed));
        xssCount += allowed;
      }
    }
  }

  if (xssEnabled) {
    log.info(`xss: planned ${xssCount} canary tests${xssCount >= xssMaxTestCases ? `, capped at ${xssMaxTestCases}` : ''}`);
  }

  // Orphan-fixture warning: bodyFixtures keys not in catalog
  if (config.bodyFixtures !== undefined) {
    const catalogIds = new Set(enrichedTools.map(t => t.toolId));
    const configRoles = config.roles ?? [];
    for (const [toolId, roleMap] of Object.entries(config.bodyFixtures)) {
      if (!catalogIds.has(toolId)) {
        log.warn('bodyFixture references unknown toolId', { toolId, roles: Object.keys(roleMap) });
        continue;
      }
      for (const role of Object.keys(roleMap)) {
        if (role !== '*' && configRoles.length > 0 && !configRoles.includes(role)) {
          log.warn(`bodyFixture for tool ${toolId} has unknown role "${role}"`, { toolId, role });
        }
      }
    }
  }

  const concurrency = config.concurrency ?? 4;
  const apiConcurrency = config.apiConcurrency ?? 16;
  const uiTests = testCases.filter(t => t.action.via === 'ui').length;
  const apiTests = testCases.filter(t => t.action.via === 'api').length;
  const uiTimeMs = Math.ceil(uiTests / concurrency) * AVG_TEST_MS;
  const apiTimeMs = Math.ceil(apiTests / apiConcurrency) * AVG_TEST_MS;
  const projectedRuntimeMs = Math.max(uiTimeMs, apiTimeMs);

  const hrs = Math.floor(projectedRuntimeMs / 3_600_000);
  const mins = Math.floor((projectedRuntimeMs % 3_600_000) / 60_000);
  log.info(
    `Plan complete. Projected: ${testCases.length} tests · concurrency ${concurrency} (browser) + ${apiConcurrency} (api) · est. ${hrs}h ${mins}m`
  );
  process.stdout.write(
    `\nProjected: ${testCases.length} tests · concurrency ${concurrency} (browser) + ${apiConcurrency} (api) · est. ${hrs}h ${mins}m\n` +
    `Set --max-runtime to a higher value or pass --budget <ms> to time-box this run.\n\n`
  );

  const skipReasons = [...skipReasonCounts.entries()].map(([reason, count]) => ({ reason, count }));

  if (skipReasons.length > 0) {
    log.info('plan: skipped submit tests by probe', { skipReasons });
  }

  return { testCases, projectedRuntimeMs, upgradedToolIds, skipReasons };
}

async function enrichToolSchemas(
  tools: ToolMeta[],
  role: string,
  surface: SurfaceMcpAdapter,
  upgradedToolIds: string[]
): Promise<ToolMeta[]> {
  const result: ToolMeta[] = [];
  for (const tool of tools) {
    // 'partial' tools already had a probe attempt; don't re-probe (§8)
    if (tool.inputSchemaConfidence !== 'unknown') {
      result.push(tool);
      continue;
    }
    const probe = await surface.surface_probe({ toolId: tool.toolId, role }).catch(() => null);
    if (probe?.recoveredSchema !== undefined && probe.confidence === 'inferred') {
      upgradedToolIds.push(tool.toolId);
      result.push({
        ...tool,
        inputSchema: probe.recoveredSchema,
        inputSchemaConfidence: 'inferred',
      });
      log.info(`Probe upgraded tool ${tool.toolId} to inferred`);
    } else {
      result.push(tool);
    }
  }
  return result;
}

type StateContext = NonNullable<TestCase['stateContext']>;

function renderTestCase(runId: string, role: string, route: string, stateContext?: StateContext): TestCase {
  return {
    id: createId(),
    runId,
    role,
    page: route,
    action: { kind: 'render', via: 'ui', expectedOutcome: 'success', palette: 'happy' },
    expectedOutcome: 'success',
    palette: 'happy',
    stateContext,
  };
}

function navigateTestCase(runId: string, role: string, page: string, target: string, stateContext?: StateContext): TestCase {
  return {
    id: createId(),
    runId,
    role,
    page,
    action: { kind: 'navigate', via: 'ui', expectedOutcome: 'unknown', palette: 'happy', selector: target },
    expectedOutcome: 'unknown',
    palette: 'happy',
    stateContext,
  };
}

function clickTestCase(runId: string, role: string, page: string, selector: string, stateContext?: StateContext): TestCase {
  return {
    id: createId(),
    runId,
    role,
    page,
    action: { kind: 'click', via: 'ui', expectedOutcome: 'success', palette: 'happy', selector },
    expectedOutcome: 'success',
    palette: 'happy',
    stateContext,
  };
}

/**
 * Determines whether submit tests should be emitted for a (role, page, form) tuple.
 * When probes are undefined (legacy/no-probe path), always emits.
 * When a probe result says formPresent:false, skips with the appropriate reason.
 */
export function shouldEmitSubmitTest(
  role: string,
  page: DiscoveredPage,
  form: DiscoveredForm,
  probes: Map<ProbeKey, ProbeResult> | undefined,
): { emit: boolean; skipReason?: string } {
  if (probes === undefined) return { emit: true };

  // Only state-kind pages have probes; url-kind pages always emit
  if (page.kind !== 'state') return { emit: true };

  const key = buildProbeKey(role, page.route, form.formSelector);
  const result = probes.get(key);

  // No probe result: budget was exhausted; default to emit
  if (result === undefined) return { emit: true };

  if (!result.formPresent) {
    const reason = result.reason === 'trigger_not_found'
      ? 'state_trigger_not_reproducible'
      : 'form_unreachable_for_role';
    return { emit: false, skipReason: reason };
  }

  return { emit: true };
}
