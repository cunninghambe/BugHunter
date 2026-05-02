// Phase 2: plan — schema enrichment + test plan generation + budget (§ 3.4).

import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type {
  BugHunterConfig, DiscoveredForm, DiscoveredPage, DiscoveryOutput, TestCase, ToolMeta,
  RaceConditionsConfig, InterleavingVariant,
  Action, FuzzConfig, NetworkFaultSpec,
} from '../types.js';
import { resolveFaultPalette, isToolDenylisted } from '../security/network-fault-palette.js';
import type { FuzzOptions, FuzzStrategy } from '../mutation/fuzz.js';
import {
  DEFAULT_VARIANTS,
  extractMutatingActionTuples,
  pairSiblings,
  isSensitiveToolPath,
  isIdempotentTool,
  makeDoubleSubmit,
  makeClickThenNavigate,
  makeOptimisticRevert,
  makeInterleavedMutations,
  makeCrossTab,
} from '../security/interleaving-palette.js';
import { detectDateSensitiveReasons, classifyDateSensitiveBatch, ALL_CLOCK_CONDITION_NAMES } from '../security/clock-test-runner.js';
import { defaultConditionsForReasons } from '../security/clock-conditions.js';
import { formTestCases, apiTestCases, xssFormTestCases, xssApiTestCases } from '../mutation/apply.js';
import { formCollapseSignature } from '../discovery/element-collapse.js';
import { log } from '../log.js';
import { createId } from '@paralleldrive/cuid2';
import { probeKey as buildProbeKey, type ProbeKey, type ProbeResult } from './form-reachability-probe.js';
import { isReadOnlyTool } from '../util/read-only.js';

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

  // v0.45 Tier 2: build the read-only tool allow-set (GET/HEAD/OPTIONS AND safe).
  const readOnlyEnabled = config.readOnly === true;
  const readOnlyToolIds = readOnlyEnabled
    ? new Set(enrichedTools.filter(t => isReadOnlyTool(t)).map(t => t.toolId))
    : undefined;

  const testCases: TestCase[] = [];
  const seenFormSigs = new Set<string>(); // per-role, across pages
  const seenElementSigs = new Map<string, Set<string>>(); // role -> Set of sigs
  const skipReasonCounts = new Map<string, number>();

  const xssEnabled = config.xss?.enabled ?? true;
  const xssDepth = config.xss?.depth ?? 'minimal';
  const xssMaxTestCases = config.xss?.maxTestCases ?? 200;
  const xssMutateJsonBodies = config.xss?.mutateJsonBodies ?? true;
  let xssCount = 0;

  const fuzzOpts = resolveFuzzOptions(config.fuzz, runId);

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
            // v0.45: conservative skip — button tool IDs are not resolved at plan time,
            // so we cannot prove any button click is read-only.
            if (readOnlyToolIds !== undefined) {
              skipReasonCounts.set('read_only_skipped_unknown_button', (skipReasonCounts.get('read_only_skipped_unknown_button') ?? 0) + 1);
              continue;
            }
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

          // v0.45: skip forms whose tools include any mutating tool.
          if (readOnlyToolIds !== undefined) {
            const formToolIds = form.apiToolIds ?? [];
            const hasMutatingTool = formToolIds.length === 0 || formToolIds.some(tid => !readOnlyToolIds.has(tid));
            if (hasMutatingTool) {
              skipReasonCounts.set('read_only_skipped_mutating_form', (skipReasonCounts.get('read_only_skipped_mutating_form') ?? 0) + 1);
              log.debug('plan: read-only skipping form (mutating tools)', { role, page: page.route, form: form.formSelector });
              continue;
            }
          }

          const { emit, skipReason } = shouldEmitSubmitTest(role, page, form, probes);
          if (!emit) {
            const reason = skipReason ?? 'form_unreachable_for_role';
            skipReasonCounts.set(reason, (skipReasonCounts.get(reason) ?? 0) + 1);
            log.debug('plan: skipping submit tests', { role, page: page.route, form: form.formSelector, skipReason: reason });
            continue;
          }
          const cases = formTestCases(runId, role, page.route, form, runId, config.domainHints, pageStateCtx, fuzzOpts);
          testCases.push(...cases);

          // XSS canary injection for this form
          if (xssEnabled && xssCount < xssMaxTestCases && readOnlyToolIds === undefined) {
            const xssCases = xssFormTestCases(runId, role, page.route, form, xssDepth, pageStateCtx);
            const allowed = Math.min(xssCases.length, xssMaxTestCases - xssCount);
            testCases.push(...xssCases.slice(0, allowed));
            xssCount += allowed;
          }
        }
      }
    }

    // v0.22 nav-state test generation (§3.4) — runs after all per-page test factories.
    // Master toggle: enableNavState (or implied by enableNavStateRefreshRace / enableHistoryCorruption).
    const navEnabled = config.enableNavState === true || config.enableNavStateRefreshRace === true || config.enableHistoryCorruption === true;
    if (navEnabled) {
      const navSkipRoutes = config.navStateSkipRoutes ?? [];
      const deepLinkMaxDepth = config.navStateDeepLinkMaxDepth ?? 3;
      const navStateCount = { count: 0 };

      for (const page of discovery.pages) {
        if (isNavSkipped(page.route, navSkipRoutes)) continue;

        // State-page seeds: skip back/forward (history not meaningful); refresh and deep-link still apply.
        const isStatePage = page.kind === 'state';

        // Collect mutating-success seeds from already-generated TestCases for this (role, page).
        const mutatingSeeds = testCases.filter(tc =>
          tc.role === role &&
          tc.page === page.route &&
          tc.action.expectedOutcome === 'success' &&
          (tc.action.kind === 'click' || tc.action.kind === 'submit') &&
          tc.action.palette === 'happy'
        );

        const formSeeds = testCases.filter(tc =>
          tc.role === role &&
          tc.page === page.route &&
          tc.action.kind === 'submit' &&
          tc.action.palette === 'happy'
        );

        // Generate back-after-mutation + forward-after-back (skipped for state-pages)
        if (!isStatePage) {
          for (const seed of mutatingSeeds) {
            // back-after-mutation
            testCases.push(navTransitionTestCase(runId, role, page.route, 'back', seed.action, seed.formSignature));
            navStateCount.count++;
            // forward-after-back (always paired with back-after-mutation)
            testCases.push(navTransitionTestCase(runId, role, page.route, 'back_then_forward', seed.action, seed.formSignature));
            navStateCount.count++;
          }
        }

        // refresh-mid-mutation (flag-gated, state-pages still allowed)
        if (config.enableNavStateRefreshRace === true) {
          for (const seed of mutatingSeeds) {
            testCases.push(navTransitionTestCase(runId, role, page.route, 'refresh', seed.action, seed.formSignature));
            navStateCount.count++;
          }
        }

        // back-after-form-fill (all roles, all pages with forms; not skipped for state-pages)
        for (const seed of formSeeds) {
          if (seed.action.selector !== undefined) {
            const fillOnlySeed: Action = { ...seed.action, fillOnly: true };
            testCases.push(navTransitionTestCase(runId, role, page.route, 'back', fillOnlySeed, seed.formSignature));
            navStateCount.count++;
          }
        }

        // deep-link-no-auth: one per page for non-public roles, respecting depth cap.
        // Q3 conservative: lazy URL = appBaseUrl + route. PR #51 established that
        // camofox.scope.navigate rejects relative URLs ("Invalid url"), so absolutize here.
        if (role !== 'public' && role !== 'anonymous') {
          const routeDepth = page.route.split('/').filter(Boolean).length;
          if (routeDepth <= deepLinkMaxDepth) {
            const base = config.appBaseUrl !== undefined ? config.appBaseUrl.replace(/\/$/, '') : '';
            const capturedUrl = base !== '' && page.route.startsWith('/')
              ? `${base}${page.route}`
              : page.route;
            testCases.push(navDeepLinkTestCase(runId, role, page.route, capturedUrl));
            navStateCount.count++;
          }
        }

        // history-state-corruption (flag-gated; one per route)
        if (config.enableHistoryCorruption === true) {
          testCases.push(navHistoryCorruptTestCase(runId, role, page.route));
          navStateCount.count++;
        }
      }

      if (navStateCount.count > 0) {
        log.info(`nav-state: +${navStateCount.count} tests for role=${role}`);
      }
    }

    // Per-tool API tests — server actions are excluded (§ 3.4)
    for (const tool of enrichedTools) {
      if (tool.isServerAction) continue;

      // v0.45 Tier 2: skip mutating tools in read-only mode.
      if (readOnlyToolIds !== undefined && !readOnlyToolIds.has(tool.toolId)) {
        skipReasonCounts.set('read_only_skipped_mutating_tool', (skipReasonCounts.get('read_only_skipped_mutating_tool') ?? 0) + 1);
        continue;
      }

      const samples = await surface.surface_sample_inputs({ toolId: tool.toolId })
        .then(r => r.samples.map(s => s.input))
        .catch(() => []);

      // Resolve bodyFixture: specific role wins over wildcard
      const toolFixtures = config.bodyFixtures?.[tool.toolId];
      const bodyFixture =
        toolFixtures?.[role] ??
        toolFixtures?.['*'];

      const cases = apiTestCases(runId, role, tool, samples, config.domainHints, bodyFixture, fuzzOpts);
      testCases.push(...cases);

      // XSS canary injection for this API tool (skipped in read-only: POST/PUT bodies required)
      if (xssEnabled && xssCount < xssMaxTestCases && readOnlyToolIds === undefined) {
        const xssCases = xssApiTestCases(runId, role, tool, xssDepth, xssMutateJsonBodies);
        const allowed = Math.min(xssCases.length, xssMaxTestCases - xssCount);
        testCases.push(...xssCases.slice(0, allowed));
        xssCount += allowed;
      }
    }
  }

  if (xssEnabled) {
    if (readOnlyToolIds !== undefined) {
      skipReasonCounts.set('read_only_skipped_xss_disabled', xssCount === 0 ? 1 : 0);
      log.info('xss: canary tests disabled in read-only mode');
    } else {
      log.info(`xss: planned ${xssCount} canary tests${xssCount >= xssMaxTestCases ? `, capped at ${xssMaxTestCases}` : ''}`);
    }
  }

  // v0.19: second pass — race-condition interleaving planner
  const raceSkipReasons = new Map<string, number>();
  if (config.raceConditions?.enabled === true) {
    // Emit deprecation warning if synthetic.raceDoubleSubmit is also set (§ 2.1)
    if (config.synthetic?.raceDoubleSubmit !== undefined) {
      log.warn('synthetic.raceDoubleSubmit is deprecated; use raceConditions.doubleSubmitGapMs instead');
    }

    const toolMap = new Map<string, ToolMeta>(enrichedTools.map(t => [t.toolId, t]));
    const raceCases = planRaceTests(runId, testCases, toolMap, config.raceConditions, raceSkipReasons);
    testCases.push(...raceCases);
    log.info(`race: planned ${raceCases.length} interleaving tests`);
  }

  // v0.23: clock-testing second pass — classify date-sensitive test cases and expand per condition.
  const clockEnabled = config.clockTesting?.enabled ?? false;
  let clockVariantsCount = 0;
  if (clockEnabled) {
    const allowlist = config.clockTesting?.dateSensitiveAllowlist ?? [];
    const denylist = config.clockTesting?.dateSensitiveDenylist ?? [];

    // Classify all test cases for date-sensitivity using form/schema/DOM signals.
    // classifyDateSensitiveBatch stamps dateSensitive on matching cases.
    const classified = classifyDateSensitiveBatch(testCases, allowlist, denylist);
    testCases.length = 0;
    testCases.push(...classified);

    // Enrich with DOM relative-time-element signals from discovery pages.
    for (const tc of testCases) {
      if (tc.dateSensitive !== undefined) continue;
      const page = discovery.pages.find(p => p.route === tc.page);
      if (page?.relativeTimeElements !== undefined && page.relativeTimeElements.length > 0) {
        tc.dateSensitive = { reasons: ['dom_relative_time'] };
      }
    }

    // Enrich form-submit test cases with signals from discovered form fields.
    for (const tc of testCases) {
      if (tc.dateSensitive !== undefined) continue;
      if (tc.action.kind !== 'submit') continue;
      const page = discovery.pages.find(p => p.route === tc.page);
      if (page === undefined) continue;
      for (const form of page.forms) {
        const reasons = detectDateSensitiveReasons({
          formFields: form.fields.map(f => ({ name: f.name, type: f.type })),
        });
        if (reasons.length > 0) {
          tc.dateSensitive = { reasons };
          break;
        }
      }
    }

    // Enrich API test cases with schema signals from tool metadata.
    for (const tc of testCases) {
      if (tc.dateSensitive !== undefined) continue;
      if (tc.action.via !== 'api' || tc.action.toolId === undefined) continue;
      const tool = enrichedTools.find(t => t.toolId === tc.action.toolId);
      if (tool?.inputSchema.properties === undefined) continue;
      const reasons = detectDateSensitiveReasons({
        schemaProperties: tool.inputSchema.properties as Record<string, { format?: string }>,
      });
      if (reasons.length > 0) tc.dateSensitive = { reasons };
    }

    // Count date-sensitive unique shapes (collapsed by formSignature or toolId).
    const seenClockShapes = new Set<string>();
    const clockVariants: TestCase[] = [];

    for (const tc of testCases) {
      if (tc.dateSensitive === undefined) continue;
      if (tc.action.expectedOutcome === 'expected_failure') continue;

      const shapeKey = tc.formSignature ?? tc.action.toolId ?? tc.page;
      if (seenClockShapes.has(shapeKey)) continue;
      seenClockShapes.add(shapeKey);

      const conditions = config.clockTesting?.activeConditions ?? defaultConditionsForReasons(tc.dateSensitive.reasons);
      for (const conditionName of conditions) {
        if (!ALL_CLOCK_CONDITION_NAMES.includes(conditionName)) continue;
        clockVariants.push({
          ...tc,
          id: createId(),
          dateSensitive: { ...tc.dateSensitive, reasons: [...tc.dateSensitive.reasons] },
          // Carry condition into action palette for telemetry
          action: { ...tc.action, palette: 'happy' },
        });
      }
    }

    clockVariantsCount = clockVariants.length;
    if (clockVariantsCount > 0) {
      log.info(`clock-testing: +${clockVariantsCount} clock-conditioned variants for ${seenClockShapes.size} date-sensitive shapes`);
    }
  }

  // v0.20: network-fault test case generation (§ 3.1)
  if (config.networkFaults?.enabled === true) {
    const faultPalette = resolveFaultPalette(config.networkFaults.variants);
    const denylist = config.networkFaults.toolDenylist ?? [];
    const maxFaultTests = config.networkFaults.maxFaultTests ?? 200;
    const includeNavigation = config.networkFaults.includeNavigation ?? false;

    // Collect mutating actions from the already-generated test cases, grouped by role.
    // "Mutating" = sideEffectClass='mutating' (api) or UI click/submit (browser path).
    // Collapse by (role, action-signature, variant) to avoid combinatorial explosion.
    const faultTestsByRole = new Map<string, number>();
    const seenFaultSigs = new Set<string>();
    const faultCases: TestCase[] = [];

    for (const tc of testCases) {
      if (tc.race !== undefined) continue; // skip race test cases
      if (tc.faultInjected !== undefined) continue; // skip already-fault-injected cases

      const isMutating = tc.action.kind === 'submit'
        || tc.action.kind === 'click'
        || (tc.action.kind === 'api_call' && tc.action.expectedOutcome !== 'expected_failure');
      const isNavigating = tc.action.kind === 'navigate' || tc.action.kind === 'render';

      if (!isMutating && !(includeNavigation && isNavigating)) continue;

      // Skip tools on the denylist
      if (tc.action.toolId !== undefined && isToolDenylisted(tc.action.toolId, denylist)) continue;

      const roleCount = faultTestsByRole.get(tc.role) ?? 0;
      if (roleCount >= maxFaultTests) continue;

      for (const fault of faultPalette) {
        const sig = `${tc.role}|${tc.formSignature ?? tc.elementSignature ?? tc.action.selector ?? tc.action.kind}|${fault.kind}`;
        if (seenFaultSigs.has(sig)) continue;
        seenFaultSigs.add(sig);

        const newRoleCount = faultTestsByRole.get(tc.role) ?? 0;
        if (newRoleCount >= maxFaultTests) break;

        const faultCase: TestCase = {
          ...tc,
          id: `${tc.id}_fault_${fault.kind}`,
          expectedOutcome: 'expected_failure',
          faultInjected: fault as NetworkFaultSpec,
        };
        faultCases.push(faultCase);
        faultTestsByRole.set(tc.role, newRoleCount + 1);
      }
    }

    testCases.push(...faultCases);
    log.info(`network-faults: planned ${faultCases.length} fault-injection tests`);
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
  const uiTests = testCases.filter(t => t.action.via === 'ui' && t.race === undefined).length;
  const apiTests = testCases.filter(t => t.action.via === 'api').length;
  const raceCasesCount = testCases.filter(t => t.race !== undefined).length;
  const uiTimeMs = Math.ceil(uiTests / concurrency) * AVG_TEST_MS;
  const apiTimeMs = Math.ceil(apiTests / apiConcurrency) * AVG_TEST_MS;
  // Race tests: ≈8s each including reset; capped to raceConcurrency (default 2).
  const raceConcurrency = config.raceConditions?.raceConcurrency ?? Math.min(2, concurrency);
  const RACE_TEST_AVG_MS = 8_000;
  const raceTimeMs = raceCasesCount > 0 ? Math.ceil(raceCasesCount / raceConcurrency) * RACE_TEST_AVG_MS : 0;
  // Clock tests run sequentially (fresh context per test); add to projected runtime.
  const clockTimeMs = clockVariantsCount > 0 ? clockVariantsCount * AVG_TEST_MS : 0;
  // Race tests run after the main queue; add to projected runtime (open question 7: yes, include).
  const projectedRuntimeMs = Math.max(uiTimeMs, apiTimeMs) + raceTimeMs + clockTimeMs;

  const hrs = Math.floor(projectedRuntimeMs / 3_600_000);
  const mins = Math.floor((projectedRuntimeMs % 3_600_000) / 60_000);
  const clockNote = clockVariantsCount > 0 ? ` +${clockVariantsCount} clock` : '';
  log.info(
    `Plan complete. Projected: ${testCases.length} tests${clockNote} · concurrency ${concurrency} (browser) + ${apiConcurrency} (api) · est. ${hrs}h ${mins}m`
  );
  process.stdout.write(
    `\nProjected: ${testCases.length} tests${clockNote} · concurrency ${concurrency} (browser) + ${apiConcurrency} (api) · est. ${hrs}h ${mins}m\n` +
    `Set --max-runtime to a higher value or pass --budget <ms> to time-box this run.\n\n`
  );

  // Merge race skip reasons into the global skip reason map
  for (const [reason, count] of raceSkipReasons) {
    skipReasonCounts.set(reason, (skipReasonCounts.get(reason) ?? 0) + count);
  }

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

// ---- v0.22 nav-state test-case factories ----

/**
 * Check if a route matches any of the navStateSkipRoutes glob patterns.
 * Simple prefix/glob matching: '*' matches any segment.
 */
function isNavSkipped(route: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    // Simple glob: convert 'checkout/*' → regex
    const regexStr = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape special chars except *
      .replace(/\*/g, '[^/]*');
    if (new RegExp(`^${regexStr}$`).test(route)) return true;
    // Also check without leading slash if pattern doesn't have one
    if (!pattern.startsWith('/') && new RegExp(`^/?${regexStr}$`).test(route)) return true;
  }
  return false;
}

/**
 * Build a nav_transition TestCase for back/refresh/forward/back_then_forward transitions.
 */
function navTransitionTestCase(
  runId: string,
  role: string,
  page: string,
  transitionKind: 'back' | 'refresh' | 'back_then_forward',
  seedAction: Action,
  formSignature?: string,
): TestCase {
  return {
    id: createId(),
    runId,
    role,
    page,
    action: {
      kind: 'nav_transition',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      transition: { kind: transitionKind },
      navSeed: seedAction,
    },
    expectedOutcome: 'success',
    palette: 'happy',
    formSignature,
  };
}

/**
 * Build a deep-link-no-auth nav_transition TestCase.
 * Q3 conservative: uses lazy URL (appBaseUrl + route) rather than a captured post-auth URL.
 */
function navDeepLinkTestCase(
  runId: string,
  role: string,
  page: string,
  capturedUrl: string,
): TestCase {
  return {
    id: createId(),
    runId,
    role,
    page,
    action: {
      kind: 'nav_transition',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      transition: { kind: 'deep_link_no_auth', capturedUrl },
    },
    expectedOutcome: 'success',
    palette: 'happy',
  };
}

/**
 * Build a history-state-corruption nav_transition TestCase.
 * Uses two conflicting pushState entries per §3.2.
 */
function navHistoryCorruptTestCase(
  runId: string,
  role: string,
  page: string,
): TestCase {
  return {
    id: createId(),
    runId,
    role,
    page,
    action: {
      kind: 'nav_transition',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      transition: {
        kind: 'history_corrupt',
        pushStates: [
          { state: { v22: 'corrupt-a' }, url: `${page}?v22=a` },
          { state: { v22: 'corrupt-b' }, url: `${page}?v22=b` },
        ],
      },
    },
    expectedOutcome: 'success',
    palette: 'happy',
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

/**
 * v0.19: Race-condition second pass.
 * Consumes the happy-palette UI test cases already generated, extracts mutating-action
 * tuples, and emits one race TestCase per enabled InterleavingVariant.
 */
export function planRaceTests(
  runId: string,
  existingCases: TestCase[],
  toolMap: Map<string, ToolMeta>,
  raceConfig: RaceConditionsConfig,
  skipReasonCounts: Map<string, number>,
): TestCase[] {
  const maxTests = raceConfig.maxTests ?? 200;
  const enabledVariants = raceConfig.variants ?? DEFAULT_VARIANTS;
  const idempotentToolIds = raceConfig.idempotentToolIds ?? [];
  const aggressiveTargets = raceConfig.aggressiveRaceTargets ?? [];

  const tuples = extractMutatingActionTuples(existingCases, toolMap);
  const siblingMap = pairSiblings(tuples, raceConfig);

  const raceCases: TestCase[] = [];

  for (const tuple of tuples) {
    if (raceCases.length >= maxTests) break;

    const { toolId, toolPath, testCase } = tuple;

    for (const variantKind of enabledVariants) {
      if (raceCases.length >= maxTests) break;

      // double_submit: skip idempotent and sensitive tools
      if (variantKind === 'double_submit') {
        if (isIdempotentTool(toolId, idempotentToolIds)) {
          skipReasonCounts.set('idempotent_by_config', (skipReasonCounts.get('idempotent_by_config') ?? 0) + 1);
          continue;
        }
        if (isSensitiveToolPath(toolPath, aggressiveTargets)) {
          skipReasonCounts.set('sensitive_tool_path', (skipReasonCounts.get('sensitive_tool_path') ?? 0) + 1);
          continue;
        }
      }

      // interleaved_mutations: skip if no sibling exists for this toolId
      if (variantKind === 'interleaved_mutations') {
        const siblingToolId = siblingMap.get(toolId);
        if (siblingToolId === undefined) {
          skipReasonCounts.set('no_sibling_for_interleave', (skipReasonCounts.get('no_sibling_for_interleave') ?? 0) + 1);
          continue;
        }
        raceCases.push(makeRaceTestCase(runId, testCase, makeInterleavedMutations(siblingToolId, raceConfig)));
        continue;
      }

      // cross_tab: only if explicitly enabled (not in DEFAULT_VARIANTS; must be explicitly added by user)
      if (variantKind === 'cross_tab') {
        raceCases.push(makeRaceTestCase(runId, testCase, makeCrossTab(raceConfig)));
        continue;
      }

      // click_then_navigate: target is the first link on the same page (from the test case's page)
      if (variantKind === 'click_then_navigate') {
        // Use the page's first available link as target; fall back to '/' if none
        const targetRoute = (testCase as TestCase & { _pageLinks?: string[] })._pageLinks?.[0] ?? '/';
        raceCases.push(makeRaceTestCase(runId, testCase, makeClickThenNavigate(targetRoute)));
        continue;
      }

      if (variantKind === 'optimistic_revert') {
        raceCases.push(makeRaceTestCase(runId, testCase, makeOptimisticRevert(raceConfig)));
        continue;
      }

      // double_submit reaches here after guard checks above (idempotent + sensitive already skipped)
      raceCases.push(makeRaceTestCase(runId, testCase, makeDoubleSubmit(raceConfig)));
    }
  }

  return raceCases;
}

function makeRaceTestCase(runId: string, source: TestCase, variant: InterleavingVariant): TestCase {
  return {
    id: createId(),
    runId,
    role: source.role,
    page: source.page,
    action: { ...source.action, palette: 'happy' },
    expectedOutcome: 'success',
    palette: 'happy',
    formSignature: source.formSignature,
    stateContext: source.stateContext,
    race: { variant },
  };
}

/**
 * Resolve FuzzOptions from config (which has already been merged with CLI flags in run.ts).
 * Returns undefined when fuzz is disabled (the default).
 * EC-6: undefined seed rejects early — callers must ensure seed is set when fuzz is enabled.
 */
export function resolveFuzzOptions(fuzzCfg: FuzzConfig | undefined, runSeed: string | number): FuzzOptions | undefined {
  if (fuzzCfg?.enabled !== true) return undefined;

  const seedNum = typeof runSeed === 'number' ? runSeed : parseInt(String(runSeed), 10);
  if (!Number.isFinite(seedNum)) {
    throw new Error('--fuzz requires --seed (or runConfig.seed) for deterministic generation');
  }

  const strategies = resolveStrategies(fuzzCfg);
  const runs = Math.min(256, Math.max(1, fuzzCfg.runs ?? 16));
  const shrink = fuzzCfg.shrink ?? (runs <= 64);
  const maxTotalDraws = fuzzCfg.maxTotalDrawsPerRun ?? 25_000;

  return { strategies, runs, subSeedBase: seedNum, shrink, maxTotalDraws };
}

function resolveStrategies(fuzzCfg: FuzzConfig): FuzzStrategy[] {
  if (fuzzCfg.strategies !== undefined && fuzzCfg.strategies.length > 0) {
    return fuzzCfg.strategies;
  }
  const strategy = fuzzCfg.strategy ?? 'all';
  if (strategy === 'none') return [];
  if (strategy === 'all') return ['unicode', 'shape', 'boundary'];
  return [strategy];
}
