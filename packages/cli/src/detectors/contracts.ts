// V56: Per-detector contract type system.
// One DetectorContract per wired BugKind that has harness: true in DETECTOR_REGISTRY.
// DETECTOR_CONTRACTS is empty in V56.1 — populated incrementally in V56.2+.

import type { BugKind } from '../types.js';

/** Phases the harness will run for this detector. Must be a subset of the existing phase set. */
export type RequiredPhase =
  | 'validate'
  | 'discover'
  | 'plan'
  | 'execute'
  | 'classify'
  | 'cluster'
  | 'emit';

/** Tools the executor needs available. Used to gate execution if absent. */
export type RequiredTool = 'browser-mcp' | 'surface-mcp' | 'cdp' | 'static-analysis';

/** Surface scoping. */
export type RequiredSurface = 'web' | 'api' | 'static-source';

/** What auth shape the detector needs to do its work. */
export type RequiredRole =
  | { kind: 'none' }
  | { kind: 'any-authenticated' }
  | { kind: 'specific'; roles: string[] };

/** What page context the detector needs (parallel to RequiredSurface but at finer grain). */
export type RequiredPageContext =
  | { kind: 'any-route' }
  | { kind: 'route-pattern'; pattern: string }
  | { kind: 'specific-routes'; routes: string[] };

/** Input contract the harness checks before running. */
export type DetectorRequires = {
  phases: RequiredPhase[];
  tools: RequiredTool[];
  surface: RequiredSurface;
  role: RequiredRole;
  pageContext: RequiredPageContext;
};

/** Cluster assertion line (one entry in expected-clusters.jsonl). */
export type ClusterAssertion =
  | {
      kind: BugKind;
      expect: 'fires';
      minClusterSize: number;
      match: { page?: string; role?: string; signaturePrefix?: string };
      severity: 'critical' | 'major' | 'minor' | 'info';
    }
  | {
      kind: BugKind;
      expect: 'silent';
      reason: string;
      match?: { page?: string; role?: string };
    };

/** Fixture pointer for this detector. May be shared across N detectors. */
export type DetectorFixture = {
  /** Relative path under fixtures/detector-calibration/, e.g. "xss-mini" or shared "v21-idor-mini". */
  path: string;
  /** Which kinds this fixture serves. The harness asserts every kind appears in the fixture's
   *  expected-clusters.jsonl as either a 'fires' or 'silent' line. */
  servesKinds: BugKind[];
};

/** The contract. One per wired BugKind. Linked from DETECTOR_REGISTRY via the `harness` field. */
export type DetectorContract = {
  kind: BugKind;
  requires: DetectorRequires;
  fixture: DetectorFixture;
  /** Default budget for a single-detector run against this fixture (ms). Tier 1 hard cap is 30_000. */
  defaultBudgetMs: number;
  /** Human-readable note (one sentence). What this detector watches for. */
  note: string;
};

/** Frozen registry of contracts. Lockstep test enforces 1:1 with `harness: true` rows in DETECTOR_REGISTRY.
 *  V56.1 ships empty — V56.2 populates the first 10 detectors. */
export const DETECTOR_CONTRACTS: ReadonlyArray<DetectorContract> = [];
