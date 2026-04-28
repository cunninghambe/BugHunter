// Phase 2: plan — schema enrichment + test plan generation + budget (§ 3.4).

import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type {
  BugHunterConfig, DiscoveryOutput, TestCase, ToolMeta,
} from '../types.js';
import { formTestCases, apiTestCases } from '../mutation/apply.js';
import { formCollapseSignature } from '../discovery/element-collapse.js';
import { log } from '../log.js';
import { createId } from '@paralleldrive/cuid2';

export type PlanResult = {
  testCases: TestCase[];
  projectedRuntimeMs: number;
  upgradedToolIds: string[];
};

const AVG_TEST_MS = 7_500; // conservative estimate per test

export async function runPlan(
  runId: string,
  discovery: DiscoveryOutput,
  config: BugHunterConfig,
  roles: string[],
  surface: SurfaceMcpAdapter
): Promise<PlanResult> {
  const upgradedToolIds: string[] = [];

  // Pre-plan schema enrichment: probe unknown-confidence tools
  const enrichedTools = await enrichToolSchemas(discovery.apiTools, roles[0] ?? 'anonymous', surface, upgradedToolIds);

  const testCases: TestCase[] = [];
  const seenFormSigs = new Set<string>(); // per-role, across pages
  const seenElementSigs = new Map<string, Set<string>>(); // role -> Set of sigs

  for (const role of roles) {
    seenFormSigs.clear();
    seenElementSigs.set(role, new Set());

    // Per-page tests
    for (const page of discovery.pages) {
      // Render test (always)
      testCases.push(renderTestCase(runId, role, page.route));

      // Navigate tests per distinct link target
      const seenLinks = new Set<string>();
      for (const link of page.links) {
        if (!seenLinks.has(link)) {
          seenLinks.add(link);
          testCases.push(navigateTestCase(runId, role, page.route, link));
        }
      }

      // Click tests per collapsed element (buttons)
      const elSigs = seenElementSigs.get(role) ?? new Set<string>();
      for (const el of page.elements) {
        if (el.tag === 'button' || el.roleAttr === 'button') {
          if (!elSigs.has(el.selector)) {
            elSigs.add(el.selector);
            testCases.push(clickTestCase(runId, role, page.route, el.selector));
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
          const cases = formTestCases(runId, role, page.route, form, runId, config.domainHints);
          testCases.push(...cases);
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
    }
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

  return { testCases, projectedRuntimeMs, upgradedToolIds };
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

function renderTestCase(runId: string, role: string, route: string): TestCase {
  return {
    id: createId(),
    runId,
    role,
    page: route,
    action: { kind: 'render', via: 'ui', expectedOutcome: 'success', palette: 'happy' },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

function navigateTestCase(runId: string, role: string, page: string, target: string): TestCase {
  return {
    id: createId(),
    runId,
    role,
    page,
    action: { kind: 'navigate', via: 'ui', expectedOutcome: 'unknown', palette: 'happy', selector: target },
    expectedOutcome: 'unknown',
    palette: 'happy',
  };
}

function clickTestCase(runId: string, role: string, page: string, selector: string): TestCase {
  return {
    id: createId(),
    runId,
    role,
    page,
    action: { kind: 'click', via: 'ui', expectedOutcome: 'success', palette: 'happy', selector },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}
