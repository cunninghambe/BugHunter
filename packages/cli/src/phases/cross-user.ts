// Phase 4.5: cross-user IDOR probe matrix (v0.5 §3.1).
// Runs after execute, before classify. Re-entrant: reads/writes only via RunState.

import { createId } from '@paralleldrive/cuid2';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';
import type { BugDetection, BugCluster, RunState, TestCase } from '../types.js';
import { decodeDiscoveredIdKey } from '../security/resource-id-extractor.js';
import { log } from '../log.js';

export type CrossUserOptions = {
  runState: RunState;
  surface: SurfaceMcpAdapter;
  /** Resolved role names available in this run. */
  roles: string[];
  maxClusters: number;
  onClusterFound: (key: string) => number;
};

export type CrossUserResult = {
  detections: Array<{ testId: string; detection: BugDetection }>;
  testCases: TestCase[];
  abortReason?: 'budget' | 'max_clusters' | 'timeout';
};

const ADMIN_ROLE_HINTS = ['admin', 'owner', 'superuser'];
const CROSS_USER_REPLAY_CAP = 200;

function isAdminRole(role: string, hints: string[]): boolean {
  const lower = role.toLowerCase();
  return hints.some(h => lower.includes(h));
}

export async function runCrossUser(opts: CrossUserOptions): Promise<CrossUserResult> {
  const { runState, surface, roles, maxClusters, onClusterFound } = opts;

  const detections: Array<{ testId: string; detection: BugDetection }> = [];
  const testCases: TestCase[] = [];

  const discoveredIds = runState.discoveredIds;
  const config = runState.config;
  const crossUserCfg = config.crossUser ?? {};
  const crossRoleEnabled = crossUserCfg.crossRoleProbeEnabled !== false;
  const anonymousEnabled = crossUserCfg.anonymousProbeEnabled !== false;
  const maxReplays = crossUserCfg.maxReplays ?? CROSS_USER_REPLAY_CAP;
  const adminHints = crossUserCfg.adminRoleHints ?? ADMIN_ROLE_HINTS;

  if (!crossRoleEnabled) {
    log.info('cross-user: crossRoleProbeEnabled=false; skipping');
    return { detections, testCases };
  }

  // Catalog of all tools — needed for both anonymous sweep and cross-user matrix
  let toolCatalog: Map<string, { method: string; requiresAdmin?: boolean; sideEffectClass?: string }>;
  try {
    const { tools } = await surface.surface_list_tools();
    toolCatalog = new Map(tools.map(t => [t.toolId, { method: t.method, requiresAdmin: false, sideEffectClass: t.sideEffectClass }]));
  } catch (err) {
    log.warn('cross-user: surface_list_tools failed', { err: String(err) });
    return { detections, testCases };
  }

  let replayCount = 0;
  let abortReason: CrossUserResult['abortReason'];
  const clusterKeys = new Set<string>();

  function emitDetection(testId: string, detection: BugDetection): void {
    detections.push({ testId, detection });
  }

  if (discoveredIds === undefined || discoveredIds.size === 0) {
    // Anonymous-only fallback: replay safe tools as anonymous when no IDs are available.
    // Requires resetPolicy to be set — without a safety net, skip the sweep.
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
      replayCount += testCases.length;
    } else if (anonymousEnabled && config.resetPolicy === undefined) {
      log.info('cross-user: anonymous sweep skipped (no resetPolicy)');
    }
    log.info(
      `cross-user: ${replayCount} replays → ${detections.length} detections`
    );
    return { detections, testCases };
  }

  // Cross-role: for each source role A, replay as every other role B
  for (const [sourceRole, roleMap] of discoveredIds) {
    for (const targetRole of roles) {
      if (targetRole === sourceRole) continue;

      // Anonymous probe gating
      if (targetRole === 'anonymous' && !anonymousEnabled) continue;

      for (const [compositeKey, valueSet] of roleMap) {
        const { toolId, field } = decodeDiscoveredIdKey(compositeKey);
        // DOM-harvested IDs use synthetic toolId '__ui_dom__' — skip catalog check for these.
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

          const tc: TestCase = {
            id: testId,
            runId: runState.runId,
            role: targetRole,
            page: toolId,
            action: {
              kind: 'api_call',
              via: 'api',
              expectedOutcome: 'expected_failure',
              palette: 'happy',
              toolId,
              input: { [field]: idValue },
            },
            expectedOutcome: 'expected_failure',
            palette: 'happy',
          };
          testCases.push(tc);

          try {
            const result = await surface.surface_call({
              toolId,
              role: targetRole,
              input: { [field]: idValue },
              noAutoRelogin: true,
            });

            const status = result.status ?? 0;

            if (status === 200) {
              // Successful cross-user access — check if empty result (false-positive filter)
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

              emitDetection(testId, {
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
              });
            } else if (status === 500) {
              // 5xx during replay — emit network_5xx via existing classifier
              emitDetection(testId, {
                kind: 'network_5xx',
                rootCause: `Server error 500 during cross-user replay of ${toolId} as ${targetRole}`,
                endpoint: toolId,
                status: 500,
              });
            }
            // 401/403/404 = correct gate; no finding
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
        const tc: TestCase = {
          id: testId,
          runId: runState.runId,
          role,
          page: toolId,
          action: {
            kind: 'api_call',
            via: 'api',
            expectedOutcome: 'expected_failure',
            palette: 'happy',
            toolId,
            input: {},
          },
          expectedOutcome: 'expected_failure',
          palette: 'happy',
        };
        testCases.push(tc);

        try {
          const result = await surface.surface_call({ toolId, role, input: {}, noAutoRelogin: true });
          const status = result.status ?? 0;
          if (status === 200 && !isEmptyResult(result.body)) {
            const clusterKey = `idor_vertical_role_escalate|${toolId}|${role}`;
            if (!clusterKeys.has(clusterKey)) {
              clusterKeys.add(clusterKey);
              emitDetection(testId, {
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
              });
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

type AnonymousSweepOpts = {
  toolCatalog: Map<string, { method: string; requiresAdmin?: boolean; sideEffectClass?: string }>;
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

    count++;
    const testId = createId();
    const tc: TestCase = {
      id: testId,
      runId: runState.runId,
      role: 'anonymous',
      page: toolId,
      action: { kind: 'api_call', via: 'api', expectedOutcome: 'expected_failure', palette: 'happy', toolId, input: {} },
      expectedOutcome: 'expected_failure',
      palette: 'happy',
    };
    testCases.push(tc);

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
): BugCluster {
  const now = new Date().toISOString();
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
