// Phase 4.5: cross-user IDOR probe matrix (v0.5 §3.1, rewired by v0.21).
// Runs after execute, before classify. Re-entrant: reads/writes only via RunState.
//
// v0.21 changes:
//  - When config.idor.enabled=true, uses classifyIdorOutcome() for three new BugKinds
//    instead of the legacy 'idor_horizontal' / 'idor_vertical_role_escalate' emit path.
//  - Builds roleFixtures (per-(role, resourceType) id map) with v0.21 filters.
//  - Adds mutating-tool pass when config.idor.probeMutating=true.
//  - Legacy path unchanged when idor.enabled is false/undefined.

import { createId } from '../lib/ids.js';
import { nowIso } from '../lib/clock.js';
import type { Clock } from '../lib/clock.js';
import { perfMs } from '../lib/perf.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BugDetection, BugCluster, RunState, TestCase, IdorTelemetry } from '../types.js';
import { decodeDiscoveredIdKey, isToolPathDenied, isOpaqueSignedToken } from '../security/resource-id-extractor.js';
import { deriveResourceType } from '../security/resource-type.js';
import { classifyIdorOutcome } from '../security/idor-classifier.js';
import { log } from '../log.js';
import { isReadOnlyTool } from '../util/read-only.js';

export type CrossUserOptions = {
  runState: RunState;
  surface: SurfaceMcpAdapter;
  /** Resolved role names available in this run. */
  roles: string[];
  maxClusters: number;
  onClusterFound: (key: string) => number;
  /** v0.47+: surface name to stamp onto every emitted detection. */
  targetSurface?: string;
};

export type CrossUserResult = {
  detections: Array<{ testId: string; detection: BugDetection }>;
  testCases: TestCase[];
  abortReason?: 'budget' | 'max_clusters' | 'timeout';
  idorTelemetry?: IdorTelemetry;
};

const ADMIN_ROLE_HINTS = ['admin', 'owner', 'superuser'];
const CROSS_USER_REPLAY_CAP = 200;
const IDOR_REPLAY_CAP = 400;
const MAX_FIXTURES_PER_ROLE_RESOURCE = 5;

function isAdminRole(role: string, hints: string[]): boolean {
  const lower = role.toLowerCase();
  return hints.some(h => lower.includes(h));
}

export async function runCrossUser(opts: CrossUserOptions): Promise<CrossUserResult> {
  const { runState, surface, roles, maxClusters, onClusterFound, targetSurface } = opts;

  const detections: Array<{ testId: string; detection: BugDetection }> = [];
  const testCases: TestCase[] = [];

  const discoveredIds = runState.discoveredIds;
  const config = runState.config;
  const crossUserCfg = config.crossUser ?? {};
  const idorCfg = config.idor;
  const idorEnabled = idorCfg?.enabled === true;

  const crossRoleEnabled = crossUserCfg.crossRoleProbeEnabled !== false;
  const anonymousEnabled = crossUserCfg.anonymousProbeEnabled !== false;
  const resolvedIdorCfg = idorCfg ?? {};
  const maxReplays = idorEnabled
    ? (resolvedIdorCfg.maxReplays ?? IDOR_REPLAY_CAP)
    : (crossUserCfg.maxReplays ?? CROSS_USER_REPLAY_CAP);
  const adminHints = crossUserCfg.adminRoleHints ?? ADMIN_ROLE_HINTS;

  if (!crossRoleEnabled) {
    log.info('cross-user: crossRoleProbeEnabled=false; skipping');
    return { detections, testCases };
  }

  // Catalog of all tools — needed for both anonymous sweep and cross-user matrix
  let toolCatalog: Map<string, { method: string; path: string; requiresAdmin?: boolean; sideEffectClass?: string }>;
  try {
    const { tools } = await surface.surface_list_tools();
    toolCatalog = new Map(tools.map(t => [t.toolId, { method: t.method, path: t.path, requiresAdmin: false, sideEffectClass: t.sideEffectClass }]));
  } catch (err) {
    log.warn('cross-user: surface_list_tools failed', { err: String(err) });
    return { detections, testCases };
  }

  const clusterKeys = new Set<string>();

  let result: CrossUserResult;

  if (discoveredIds === undefined || discoveredIds.size === 0) {
    // Anonymous-only fallback: replay safe tools as anonymous when no IDs are available.
    if (anonymousEnabled && config.resetPolicy !== undefined) {
      await runAnonymousCatalogSweep({
        toolCatalog,
        surface,
        runState,
        roles,
        maxReplays,
        detections,
        testCases,
        clusterKeys,
        onClusterFound,
        maxClusters,
      });
    } else if (anonymousEnabled && config.resetPolicy === undefined) {
      log.info('cross-user: anonymous sweep skipped (no resetPolicy)');
    }
    log.info(`cross-user: ${testCases.length} replays → ${detections.length} detections`);
    result = { detections, testCases };
  } else if (idorEnabled) {
    // Anonymous sweep complements V21 — V21 detects horizontal/vertical IDOR via id-swap;
    // the anonymous sweep detects auth_bypass_via_unauthed_route on tools that should require
    // a session at all. Both are needed; enabling V21 must not silently disable the other path.
    if (anonymousEnabled && config.resetPolicy !== undefined) {
      await runAnonymousCatalogSweep({
        toolCatalog, surface, runState, roles, maxReplays,
        detections, testCases, clusterKeys, onClusterFound, maxClusters,
      });
    }
    result = await runV21IdorPass({
      toolCatalog, surface, runState, roles, maxReplays, maxClusters, onClusterFound,
      discoveredIds, detections, testCases, clusterKeys, idorCfg: resolvedIdorCfg,
      adminHints, anonymousEnabled,
    });
  } else {
    result = await runLegacyCrossUser({
      toolCatalog, surface, runState, roles, maxReplays, maxClusters, onClusterFound,
      discoveredIds, detections, testCases, clusterKeys, adminHints, anonymousEnabled,
    });
  }

  if (targetSurface !== undefined) {
    for (const { detection } of result.detections) {
      detection.surface ??= targetSurface;
    }
  }

  return result;
}

// --- v0.21 IDOR pass ---

type V21PassOpts = {
  toolCatalog: Map<string, { method: string; path: string; requiresAdmin?: boolean; sideEffectClass?: string }>;
  surface: SurfaceMcpAdapter;
  runState: RunState;
  roles: string[];
  maxReplays: number;
  maxClusters: number;
  onClusterFound: (key: string) => number;
  discoveredIds: NonNullable<RunState['discoveredIds']>;
  detections: Array<{ testId: string; detection: BugDetection }>;
  testCases: TestCase[];
  clusterKeys: Set<string>;
  idorCfg: NonNullable<RunState['config']['idor']>;
  adminHints: string[];
  anonymousEnabled: boolean;
};

async function runV21IdorPass(opts: V21PassOpts): Promise<CrossUserResult> {
  const {
    toolCatalog, surface, runState, roles, maxReplays, maxClusters, onClusterFound,
    discoveredIds, detections, testCases, clusterKeys, idorCfg, adminHints,
  } = opts;

  const startMs = perfMs();
  const maxFixtures = idorCfg.maxFixturesPerRoleResource ?? MAX_FIXTURES_PER_ROLE_RESOURCE;
  const skipResources = new Set(idorCfg.skipResources ?? []);
  const skipFixtureFromTools = new Set(idorCfg.skipFixtureFromTools ?? []);
  const probeMutating = idorCfg.probeMutating === true;

  // Validate mutating pass requires safe resetPolicy
  if (probeMutating && runState.config.resetPolicy !== 'transactional' && runState.config.resetPolicy !== 'per-test') {
    log.warn('cross-user v0.21: probeMutating=true requires resetPolicy=transactional|per-test; skipping mutating pass');
  }
  const actualProbeMutating = probeMutating &&
    (runState.config.resetPolicy === 'transactional' || runState.config.resetPolicy === 'per-test');

  // Build roleFixtures from discoveredIds with v0.21 filters
  const roleFixtures = buildRoleFixtures(discoveredIds, toolCatalog, idorCfg, maxFixtures, skipFixtureFromTools, skipResources);
  runState.roleFixtures = roleFixtures;

  const telemetry: IdorTelemetry = {
    enabled: true,
    fixturesCollected: buildFixtureCountMap(roleFixtures),
    swapsAttempted: 0,
    swapsByPair: [],
    detectionsByKind: { idor_horizontal_read: 0, idor_horizontal_mutate: 0, idor_vertical_suspicious: 0 },
    suppressedByLegitimizedHierarchy: 0,
    skippedReasons: [],
    durationMs: 0,
  };

  const pairCounts = new Map<string, number>();
  const skippedReasons = new Map<string, number>();
  let replayCount = 0;
  let abortReason: CrossUserResult['abortReason'];

  // Log warning when no peer-tier roles are available
  const nonAdminRoles = roles.filter(r => !isAdminRole(r, adminHints));
  if (nonAdminRoles.length < 2 && idorCfg.peerRoles === undefined) {
    log.warn('cross-user v0.21: idor: no peer-tier roles available; horizontal-IDOR pass skipped. Configure idor.peerRoles or add a second non-admin role.');
  }

  // Iterate over all (sourceRole, resourceType) combinations in roleFixtures
  outer: for (const [sourceRole, resourceTypeMap] of roleFixtures) {
    for (const [resourceType, idSet] of resourceTypeMap) {
      if (skipResources.has(resourceType)) continue;

      // Find tools that operate on this resourceType
      const matchingTools = getToolsForResourceType(resourceType, toolCatalog, idorCfg);

      for (const targetRole of roles) {
        if (targetRole === sourceRole) continue;
        if (targetRole === 'anonymous') continue; // anonymous handled separately in legacy path

        const pairKey = `${sourceRole}→${targetRole}`;

        for (const idValue of idSet) {
          for (const [toolId, toolInfo] of matchingTools) {
            if (toolInfo.sideEffectClass === 'external') continue;
            if (!actualProbeMutating && toolInfo.sideEffectClass === 'mutating') continue;
            // v0.45 Tier 4: in read-only mode, IDOR replays only for read-only tools.
            if (runState.config.readOnly === true && !isReadOnlyTool({ method: toolInfo.method, sideEffectClass: toolInfo.sideEffectClass ?? 'safe' })) continue;

            if (replayCount >= maxReplays) {
              abortReason = 'budget';
              break outer;
            }
            if (onClusterFound('') >= maxClusters) {
              abortReason = 'max_clusters';
              break outer;
            }

            replayCount++;
            telemetry.swapsAttempted++;
            pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);

            const testId = createId();
            testCases.push(makeTestCase(testId, runState.runId, targetRole, toolId, { id: idValue }));

            try {
              const result = await surface.surface_call({
                toolId,
                role: targetRole,
                input: { id: idValue },
                noAutoRelogin: true,
              });

              const status = result.status ?? 0;

              if (status === 500) {
                detections.push({ testId, detection: {
                  kind: 'network_5xx',
                  rootCause: `Server error 500 during IDOR replay of ${toolId} as ${targetRole}`,
                  endpoint: toolId,
                  status: 500,
                } });
                continue;
              }

              if (status === 429) {
                skippedReasons.set('rate_limited_429', (skippedReasons.get('rate_limited_429') ?? 0) + 1);
                continue;
              }

              const outcome = classifyIdorOutcome({
                sourceRole,
                targetRole,
                sideEffectClass: (toolInfo.sideEffectClass ?? 'safe') as 'safe' | 'mutating' | 'external',
                status,
                body: result.body,
                resourceType,
                idorConfig: idorCfg,
              });

              if (outcome === null) {
                if (idorCfg.legitimizedHierarchies !== undefined) {
                  // Count suppressed only if it would have been cross-tier suspicious
                  // (We know outcome is null — check if it was due to suppression)
                  const wouldBeCross = classifyIdorOutcome({
                    sourceRole, targetRole,
                    sideEffectClass: (toolInfo.sideEffectClass ?? 'safe') as 'safe' | 'mutating' | 'external',
                    status, body: result.body, resourceType,
                    idorConfig: { ...idorCfg, legitimizedHierarchies: [] },
                  });
                  if (wouldBeCross?.kind === 'idor_vertical_suspicious') {
                    telemetry.suppressedByLegitimizedHierarchy++;
                  }
                }
                continue;
              }

              // Match cluster/signature.ts: vertical_suspicious must include direction
              // so admin→alice and alice→admin produce distinct clusters (spec § 5).
              const clusterKey = outcome.kind === 'idor_vertical_suspicious'
                ? `${outcome.kind}|${resourceType}|${outcome.sourceTier}->${outcome.targetTier}`
                : `${outcome.kind}|${resourceType}|${outcome.tier}`;
              if (clusterKeys.has(clusterKey)) continue;
              clusterKeys.add(clusterKey);

              telemetry.detectionsByKind[
                outcome.kind as keyof typeof telemetry.detectionsByKind
              ]++;

              const truncatedValue = idValue.length >= 16 ? idValue.slice(0, 12) : idValue;

              detections.push({ testId, detection: {
                kind: outcome.kind,
                rootCause: buildRootCause(outcome.kind, sourceRole, targetRole, resourceType, toolId),
                endpoint: toolId,
                status,
                idorContext: {
                  sourceRole,
                  targetRole,
                  resourceField: 'id',
                  resourceValue: truncatedValue,
                  resourceType,
                  mutating: outcome.kind === 'idor_horizontal_mutate',
                  tier: outcome.tier,
                  sourceTier: outcome.sourceTier,
                  targetTier: outcome.targetTier,
                  requiresAdjudication: outcome.requiresAdjudication,
                },
              } });
            } catch (err) {
              log.warn('cross-user v0.21: replay error', { toolId, targetRole, err: String(err) });
            }
          }
        }
      }
    }
  }

  // Build swapsByPair from pairCounts
  telemetry.swapsByPair = [...pairCounts.entries()].map(([key, count]) => {
    const sep = key.indexOf('→');
    const from = sep === -1 ? key : key.slice(0, sep);
    const to = sep === -1 ? '' : key.slice(sep + 1);
    return { from, to, count };
  });
  telemetry.skippedReasons = [...skippedReasons.entries()].map(([reason, count]) => ({ reason, count }));
  telemetry.durationMs = perfMs() - startMs;

  log.info(
    `cross-user v0.21: ${replayCount} replays → ${detections.length} detections${
      abortReason !== undefined ? ` (aborted: ${abortReason})` : ''
    }`
  );

  return { detections, testCases, abortReason, idorTelemetry: telemetry };
}

function buildRootCause(
  kind: string,
  sourceRole: string,
  targetRole: string,
  resourceType: string,
  toolId: string,
): string {
  if (kind === 'idor_horizontal_mutate') {
    return `IDOR horizontal mutate: ${targetRole} successfully mutated ${sourceRole}'s ${resourceType} resource via ${toolId}`;
  }
  if (kind === 'idor_horizontal_read') {
    return `IDOR horizontal read: ${targetRole} can read ${sourceRole}'s ${resourceType} resource via ${toolId}`;
  }
  return `IDOR vertical suspicious: cross-tier access on ${resourceType} resource via ${toolId} (${sourceRole}→${targetRole}); requires adjudication`;
}

/**
 * Build the roleFixtures map from discoveredIds with v0.21 deny-list filters applied.
 */
function buildRoleFixtures(
  discoveredIds: NonNullable<RunState['discoveredIds']>,
  toolCatalog: Map<string, { method: string; path: string; requiresAdmin?: boolean; sideEffectClass?: string }>,
  idorCfg: NonNullable<RunState['config']['idor']>,
  maxFixtures: number,
  skipFixtureFromTools: Set<string>,
  skipResources: Set<string>,
): Map<string, Map<string, Set<string>>> {
  const roleFixtures = new Map<string, Map<string, Set<string>>>();

  for (const [role, roleMap] of discoveredIds) {
    for (const [compositeKey, valueSet] of roleMap) {
      const { toolId, field } = decodeDiscoveredIdKey(compositeKey);

      // Skip user-configured tool deny-list
      if (skipFixtureFromTools.has(toolId)) continue;

      // Skip tools on the built-in path deny-list
      const toolInfo = toolCatalog.get(toolId);
      const toolPath = toolInfo?.path ?? toolId;
      if (isToolPathDenied(toolPath)) continue;

      for (const idValue of valueSet) {
        // Skip opaque signed tokens (EC-9)
        if (isOpaqueSignedToken(idValue)) continue;

        const resourceType = deriveResourceType(toolId, toolPath, field, idorCfg);
        if (skipResources.has(resourceType)) continue;

        let roleMap2 = roleFixtures.get(role);
        if (roleMap2 === undefined) {
          roleMap2 = new Map();
          roleFixtures.set(role, roleMap2);
        }

        let typeSet = roleMap2.get(resourceType);
        if (typeSet === undefined) {
          typeSet = new Set();
          roleMap2.set(resourceType, typeSet);
        }

        // Per-(role, resourceType) cap
        if (typeSet.size < maxFixtures) {
          typeSet.add(idValue);
        }
      }
    }
  }

  return roleFixtures;
}

/**
 * Find tools that operate on the given resourceType.
 * A tool "operates on" a resourceType if deriveResourceType() yields that type for its path.
 */
function getToolsForResourceType(
  resourceType: string,
  toolCatalog: Map<string, { method: string; path: string; requiresAdmin?: boolean; sideEffectClass?: string }>,
  idorCfg: NonNullable<RunState['config']['idor']>,
): Map<string, { method: string; path: string; requiresAdmin?: boolean; sideEffectClass?: string }> {
  const result = new Map<string, { method: string; path: string; requiresAdmin?: boolean; sideEffectClass?: string }>();
  for (const [toolId, toolInfo] of toolCatalog) {
    const derived = deriveResourceType(toolId, toolInfo.path, '', idorCfg);
    if (derived === resourceType) {
      result.set(toolId, toolInfo);
    }
  }
  return result;
}

function buildFixtureCountMap(
  roleFixtures: Map<string, Map<string, Set<string>>>,
): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [role, rtMap] of roleFixtures) {
    out[role] = {};
    for (const [rt, idSet] of rtMap) {
      out[role][rt] = idSet.size;
    }
  }
  return out;
}

// --- Legacy v0.5 cross-user pass (unchanged behavior) ---

type LegacyPassOpts = {
  toolCatalog: Map<string, { method: string; path: string; requiresAdmin?: boolean; sideEffectClass?: string }>;
  surface: SurfaceMcpAdapter;
  runState: RunState;
  roles: string[];
  maxReplays: number;
  maxClusters: number;
  onClusterFound: (key: string) => number;
  discoveredIds: NonNullable<RunState['discoveredIds']>;
  detections: Array<{ testId: string; detection: BugDetection }>;
  testCases: TestCase[];
  clusterKeys: Set<string>;
  adminHints: string[];
  anonymousEnabled: boolean;
};

async function runLegacyCrossUser(opts: LegacyPassOpts): Promise<CrossUserResult> {
  const {
    toolCatalog, surface, runState, roles, maxReplays, maxClusters, onClusterFound,
    discoveredIds, detections, testCases, clusterKeys, adminHints, anonymousEnabled,
  } = opts;

  let replayCount = 0;
  let abortReason: CrossUserResult['abortReason'];

  // Cross-role: for each source role A, replay as every other role B
  for (const [sourceRole, roleMap] of discoveredIds) {
    for (const targetRole of roles) {
      if (targetRole === sourceRole) continue;

      if (targetRole === 'anonymous' && !anonymousEnabled) continue;

      for (const [compositeKey, valueSet] of roleMap) {
        const { toolId, field } = decodeDiscoveredIdKey(compositeKey);
        if (!toolId.startsWith('__ui_') && !toolCatalog.has(toolId)) continue;

        for (const idValue of valueSet) {
          if (replayCount >= maxReplays) {
            abortReason = 'budget';
            break;
          }
          if (onClusterFound('') >= maxClusters) {
            abortReason = 'max_clusters';
            break;
          }

          replayCount++;
          const testId = createId();
          testCases.push(makeTestCase(testId, runState.runId, targetRole, toolId, { [field]: idValue }));

          try {
            const result = await surface.surface_call({
              toolId,
              role: targetRole,
              input: { [field]: idValue },
              noAutoRelogin: true,
            });

            const status = result.status ?? 0;

            if (status === 200) {
              const body = result.body;
              if (isEmptyResult(body)) continue;

              const clusterKey = targetRole === 'anonymous'
                ? `auth_bypass_via_unauthed_route|${toolId}`
                : `idor_horizontal|${toolId}|${field}`;

              if (clusterKeys.has(clusterKey)) continue;
              clusterKeys.add(clusterKey);

              const kind = targetRole === 'anonymous'
                ? 'auth_bypass_via_unauthed_route' as const
                : 'idor_horizontal' as const;

              detections.push({ testId, detection: {
                kind,
                rootCause: kind === 'auth_bypass_via_unauthed_route'
                  ? `Route ${toolId} accessible without authentication`
                  : `IDOR: ${sourceRole}'s ${field}=${idValue} accessible as ${targetRole}`,
                endpoint: toolId,
                status,
                idorContext: {
                  sourceRole,
                  targetRole,
                  resourceField: field,
                  resourceValue: idValue,
                },
              } });
            } else if (status === 500) {
              detections.push({ testId, detection: {
                kind: 'network_5xx',
                rootCause: `Server error 500 during cross-user replay of ${toolId} as ${targetRole}`,
                endpoint: toolId,
                status: 500,
              } });
            }
          } catch (err) {
            log.warn('cross-user: replay error', { toolId, targetRole, err: String(err) });
          }
        }

        if (abortReason !== undefined) break;
      }

      if (abortReason !== undefined) break;
    }

    if (abortReason !== undefined) break;
  }

  // Vertical escalation: non-admin roles trying admin tools
  if (abortReason === undefined) {
    for (const [toolId, toolInfo] of toolCatalog) {
      if (toolInfo.requiresAdmin !== true) continue;

      const nonAdminRoles = roles.filter(r => !isAdminRole(r, adminHints));
      for (const role of nonAdminRoles) {
        if (replayCount >= maxReplays) {
          abortReason = 'budget';
          break;
        }

        replayCount++;
        const testId = createId();
        testCases.push(makeTestCase(testId, runState.runId, role, toolId, {}));

        try {
          const result = await surface.surface_call({ toolId, role, input: {}, noAutoRelogin: true });
          const status = result.status ?? 0;
          if (status === 200 && !isEmptyResult(result.body)) {
            const clusterKey = `idor_vertical_role_escalate|${toolId}|${role}`;
            if (!clusterKeys.has(clusterKey)) {
              clusterKeys.add(clusterKey);
              detections.push({ testId, detection: {
                kind: 'idor_vertical_role_escalate',
                rootCause: `Admin route ${toolId} accessible as non-admin role '${role}'`,
                endpoint: toolId,
                status,
                idorContext: {
                  sourceRole: role,
                  targetRole: role,
                  resourceField: '',
                  resourceValue: '',
                },
              } });
            }
          }
        } catch (err) {
          log.warn('cross-user: vertical probe error', { toolId, role, err: String(err) });
        }
      }

      if (abortReason !== undefined) break;
    }
  }

  log.info(
    `cross-user: ${replayCount} replays → ${detections.length} detections${
      abortReason !== undefined ? ` (aborted: ${abortReason})` : ''
    }`
  );

  return { detections, testCases, abortReason };
}

// --- Shared helpers ---

type AnonymousSweepOpts = {
  toolCatalog: Map<string, { method: string; path: string; requiresAdmin?: boolean; sideEffectClass?: string }>;
  surface: SurfaceMcpAdapter;
  runState: RunState;
  roles: string[];
  maxReplays: number;
  detections: Array<{ testId: string; detection: BugDetection }>;
  testCases: TestCase[];
  clusterKeys: Set<string>;
  onClusterFound: (key: string) => number;
  maxClusters: number;
};

/**
 * Anonymous-only catalog sweep: replay safe, non-admin tools as 'anonymous' role.
 * Used as a fallback when discoveredIds is empty. Only runs when resetPolicy is set.
 * Capped at maxReplays / 2 to leave budget for the ID matrix when it does exist.
 */
async function runAnonymousCatalogSweep(opts: AnonymousSweepOpts): Promise<void> {
  const { toolCatalog, surface, runState, maxReplays, detections, testCases, clusterKeys, onClusterFound, maxClusters } = opts;
  const cap = Math.floor(maxReplays / 2);
  let count = 0;

  for (const [toolId, toolInfo] of toolCatalog) {
    if (count >= cap) break;
    if (toolInfo.requiresAdmin === true) continue;
    if (toolInfo.sideEffectClass !== 'safe') continue;
    // v0.45 Tier 4: in read-only mode, anonymous sweep additionally requires GET/HEAD/OPTIONS.
    if (runState.config.readOnly === true && !isReadOnlyTool({ method: toolInfo.method, sideEffectClass: toolInfo.sideEffectClass ?? 'safe' })) continue;

    count++;
    const testId = createId();
    testCases.push(makeTestCase(testId, runState.runId, 'anonymous', toolId, {}));

    if (onClusterFound('') >= maxClusters) break;

    try {
      const result = await surface.surface_call({ toolId, role: 'anonymous', input: {}, noAutoRelogin: true });
      const status = result.status ?? 0;
      if (status === 200 && !isEmptyResult(result.body)) {
        const key = `auth_bypass_via_unauthed_route|${toolId}`;
        if (!clusterKeys.has(key)) {
          clusterKeys.add(key);
          detections.push({
            testId,
            detection: {
              kind: 'auth_bypass_via_unauthed_route',
              rootCause: `Route ${toolId} accessible without authentication`,
              endpoint: toolId,
              status,
            },
          });
        }
      }
    } catch (err) {
      log.warn('cross-user: anonymous sweep error', { toolId, err: String(err) });
    }
  }
}

function makeTestCase(
  testId: string,
  runId: string,
  role: string,
  toolId: string,
  input: Record<string, unknown>,
): TestCase {
  return {
    id: testId,
    runId,
    role,
    page: toolId,
    action: {
      kind: 'api_call',
      via: 'api',
      expectedOutcome: 'expected_failure',
      palette: 'happy',
      toolId,
      input,
    },
    expectedOutcome: 'expected_failure',
    palette: 'happy',
  };
}

function isEmptyResult(body: unknown): boolean {
  if (body === null || body === undefined) return true;
  if (Array.isArray(body) && body.length === 0) return true;
  if (
    typeof body === 'object' &&
    !Array.isArray(body) &&
    'data' in (body as Record<string, unknown>)
  ) {
    const data = (body as Record<string, unknown>).data;
    if (Array.isArray(data) && data.length === 0) return true;
    if (data === null) return true;
  }
  return false;
}

/** Synthesise a BugCluster from a cross-user detection for direct injection into the cluster pipeline. */
export function crossUserDetectionToCluster(
  detection: BugDetection,
  runId: string,
  clusterKey: string,
  clock: Clock = { kind: 'wall' },
): BugCluster {
  const now = nowIso(clock);
  return {
    id: createId(),
    runId,
    kind: detection.kind,
    rootCause: detection.rootCause,
    firstSeenAt: now,
    lastSeenAt: now,
    clusterSize: 1,
    occurrences: [],
    suspectedFiles: [],
    fixHints: [],
    thirdPartyOrGenerated: false,
    stackTraceFingerprint: clusterKey,
  };
}
