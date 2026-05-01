# SPEC — v0.21 "IDOR / horizontal-authorization testing"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Depends on:** v0.5 cross-user matrix (`packages/cli/src/phases/cross-user.ts`, `security/resource-id-extractor.ts`, `security/dom-id-harvester.ts`), v0.14 seed-data hooks (for legitimate cross-tenant fixtures), v0.16 pen-testing palette (priority slotting reference) · **Sibling:** `SPEC_V07_AUTH_FLOWS.md`.

This spec turns BugHunter's existing primitive cross-user replay (v0.5) into a real **horizontal-authorization** test pass. Today's `cross-user.ts` flags any cross-role 200 with a non-empty body as `idor_horizontal`, conflating three distinct cases: peer A reading peer B's data (the canonical IDOR), peer A mutating peer B's data (one tier worse), and a higher-tier role legitimately reading a lower-tier role's data (often by-design — e.g. an admin reading a customer's order). This single-bucket clustering buries real vulnerabilities under noise on tenant-scoped apps and produces false positives on hierarchical apps. v0.21 splits the kind, adds resource-typing, distinguishes read from mutate, requires explicit configuration to legitimize cross-tier reads, and tightens the fixture-collection rules so we don't over-harvest credentials, presence-only data, or obviously shared catalog rows.

The cross-role replay loop already exists. v0.21 is a **classifier + fixture-collection + config refinement**, not a new phase.

---

## 1. Problem Statement

OWASP A01:2021 ("Broken Access Control") is the #1 production-shipped vulnerability class. The exact failure mode that ships most often is **horizontal privilege escalation**: user A is authenticated, but the route handler for `/orders/:id` resolves the order without verifying the order belongs to user A. User B's session, sending user A's order id, gets a 200 with user A's data.

BugHunter today exercises every (role, route, element) tuple **with that role's own session**. It never has user A's session attempt user B's resource id. The v0.5 cross-user phase took the first cut by replaying a discovered id from role A's surface against role B's session, but it (a) does not distinguish read from mutate (a horizontal mutate is much worse than a horizontal read of public-by-default data), (b) does not distinguish peer-tier from vertical-tier (admins reading customer data is sometimes correct), and (c) over-clusters: every (toolId, field) pair becomes its own bucket regardless of the underlying resource type, fragmenting the report.

v0.21 ships:
1. **Three precise BugKinds** that replace the v0.5 `idor_horizontal` / `idor_vertical_role_escalate` umbrella: `idor_horizontal_read`, `idor_horizontal_mutate`, `idor_vertical_suspicious`.
2. **Resource-type identification** so two tools that operate on the same `orders` resource cluster together when they share a vulnerability shape.
3. **Tighter passive fixture collection** that respects user privacy: no credentials, no auth-state, no `/api/me` self-references; capped per (role, resourceType); deduplicated.
4. **Explicit peer-tier vs vertical-tier configuration** so admins-reading-customer-data flags `idor_vertical_suspicious` (review required) instead of `idor_horizontal` (false bug).
5. **Mutating-action coverage** — for every (resourceType, mutating tool), call as roleB with roleA's id and verify a 4xx, redirect, or rolled-back state.

---

## 2. Boundaries

### 2.1 In scope

- Three new `BugKind`s in `packages/cli/src/types.ts`.
- Extension of existing `IdorContext` to carry `resourceType`, `mutating`, and `tier` fields.
- Resource-type derivation utility (URL-pattern based) with user-overrides via config.
- Peer-tier auto-inference (default: every non-admin-hint role is peer with every other non-admin-hint role).
- Explicit `idor.legitimizedHierarchies` config to suppress vertical-tier findings that are by-design.
- Fixture-collection rules tightened in `security/resource-id-extractor.ts` and `security/dom-id-harvester.ts`: deny-list for auth-bound tools, dedupe across paths, per-(role, resourceType) cap.
- Cluster-signature additions in `cluster/signature.ts` keyed on `resourceType` (not raw `toolId`).
- Priority-hierarchy slotting in `phases/classify.ts`: the three new kinds rank above `network_4xx_unexpected` and `surface_call_failed`, below `network_5xx`.
- CLI flag `--idor` / config `idor.enabled` (default `true` when `--security` is set; otherwise off).
- Telemetry block on `summary.json.idor`.

### 2.2 Out of scope (deferred)

- Tenant-scoped resources where every role is its own tenant **and** ids are namespaced (e.g. compound `tenantId:orderId` keys) — these never trigger v0.5 today because the id from tenant A simply doesn't exist in tenant B's namespace. v0.21 logs this as `skipped: cross_tenant_namespace_distinct` and defers richer modeling to v0.22.
- Mass-assignment / parameter pollution (sending `userId: <victim>` in a body to overwrite ownership). Different probe class. v0.22.
- Object-level filter bypass (`?userId=victim` query-string injection on list endpoints that accept a filter param). v0.22.
- Field-level disclosure (response includes a forbidden field even when the endpoint is correctly gated). v0.23 — needs schema-aware diff.
- Vertical privilege escalation **from low to high** — covered by the existing `idor_vertical_role_escalate` kind; v0.21 does not modify that path. The new `idor_vertical_suspicious` strictly covers the high-to-low direction (admin sees customer data, sometimes legitimate).
- Multi-step IDOR where the id must be obtained via one role then redeemed via another (rare; v0.22 if telemetry shows demand).

### 2.3 External dependencies

- No new runtime dependencies.
- SurfaceMCP `ToolMeta.sideEffectClass: 'mutating' | 'safe' | 'external'` — already present, used to gate the read-vs-mutate split.
- SurfaceMCP `ToolMeta.path` — used for URL-pattern resource-type extraction.

---

## 3. Architecture Decisions

### 3.1 Fixture collection happens during the normal walk; v0.21 only tightens it

The v0.5 architecture already harvests resource ids passively:

- After every successful API response: `extractIdsFromBody` (in `security/resource-id-extractor.ts`) walks the JSON body, finds id-shaped fields, calls `mergeDiscoveredIds(map, role, toolId, ids)`.
- After every UI test post-snapshot: `harvestIdsFromDom` extracts ids from rendered DOM (`data-id` attributes, route-pattern `/<entity>/<id-shaped-segment>` matches).
- Both paths funnel into `runState.discoveredIds: Map<role, Map<toolId+field, Set<id>>>`.

**v0.21 does not introduce a new collection pass.** It tightens the existing pass with four filters (per § 6) and adds a parallel `runState.roleFixtures: Map<role, Map<resourceType, Set<id>>>` derived from the existing data plus URL-pattern resource-type extraction. This keeps the collection cost zero; the only added work is a per-id resource-type lookup at insert time.

The decision is to **not** add a new phase. The cross-role replay loop in `phases/cross-user.ts` is the same loop v0.21 needs; this spec rewires its classification, not its iteration.

### 3.2 Planner generates swap tests; classifier evaluates the response

The cross-role swap tests already exist in `phases/cross-user.ts` (lines 97–203 in current main). v0.21:

1. Augments the loop with a **mutating pass**: for every (resourceType, mutatingToolId, peer pair (A, B)), invoke the tool as B with A's id from `roleFixtures[A][resourceType]`. Today's loop only iterates by `(toolId, field)` from `discoveredIds`; v0.21 adds the symmetric (resourceType, mutating tool) iteration so DELETE/PATCH/PUT tools that don't appear in any role's GET response body still get probed.
2. Replaces the binary `200 → idor_horizontal` classifier with the three-kind decision tree in § 5.

### 3.3 The classifier is the only place that decides peer vs vertical

`phases/cross-user.ts` knows the source role and target role of every replay. It calls a single new helper `classifyIdorOutcome({ sourceRole, targetRole, tool, response, config })` which returns one of:

- `null` — no finding (4xx, 3xx, empty body, or response shape indicates correct gating).
- `{ kind: 'idor_horizontal_read', resourceType, ... }` — peer A read peer B's resource (or vice versa).
- `{ kind: 'idor_horizontal_mutate', resourceType, ... }` — peer A mutated peer B's resource.
- `{ kind: 'idor_vertical_suspicious', resourceType, ... }` — cross-tier access; needs human review (unless suppressed by config).

The classifier is a pure function. It reads from `runState.config.idor` for hierarchy / suppression rules. No I/O.

---

## 4. Bug classification additions + priority slotting

### 4.1 New `BugKind`s (in `packages/cli/src/types.ts`)

Add to the `BugKind` union:

```ts
// v0.21 IDOR / horizontal-authz kinds (replace the v0.5 'idor_horizontal' umbrella)
| 'idor_horizontal_read'
| 'idor_horizontal_mutate'
| 'idor_vertical_suspicious'
```

The legacy `'idor_horizontal'` and `'idor_vertical_role_escalate'` kinds remain in the union for backward compat with existing serialized run artifacts (replay, retest), but the v0.21 classifier no longer emits them. A migration helper in `cli/inspect.ts` displays old kinds with a "deprecated; see v0.21" banner. Removing them entirely is a v0.22 concern; today's existing artifacts must remain readable.

### 4.2 Detection rules

| Kind | Trigger |
|---|---|
| `idor_horizontal_read` | Peer-tier source-role's id, replayed against a peer-tier target-role's session, on a `safe`-class tool, returns 2xx with non-empty body that includes the source-role's id (or shape indicates source-role's record returned). |
| `idor_horizontal_mutate` | Same as above but on a `mutating`-class tool, AND the response is 2xx (not 4xx). The mutation is presumed to have succeeded; spec § 7 defines what "presumed to have succeeded" means and how the run rolls back. |
| `idor_vertical_suspicious` | Cross-tier access (source role and target role belong to different tiers per `idor.tiers` or admin-hint inference) returns 2xx with non-empty body. **Suppressed** when the (sourceTier, targetTier) pair matches a `idor.legitimizedHierarchies` entry. |

### 4.3 Priority slotting (`phases/classify.ts`'s `KIND_PRIORITY`)

Insert directly after `'jwt_weak_alg'` and before the legacy `'idor_horizontal'` entry. Final order in that band:

```
...
'sql_injection',
'command_injection',
'path_traversal',
'jwt_weak_alg',
// v0.21 IDOR (above legacy idor entries)
'idor_horizontal_mutate',     // mutate is worse than read
'idor_horizontal_read',
'idor_vertical_suspicious',
// legacy v0.5 (kept for backward compat; not emitted by v0.21)
'idor_horizontal',
'idor_vertical_role_escalate',
'auth_bypass_via_unauthed_route',
...
```

**Rationale:** an authenticated horizontal mutate is strictly worse than an unauthenticated read of the same resource (`auth_bypass_via_unauthed_route`). It indicates the gate exists for unauthenticated callers but not for cross-tenant authenticated callers — the worst kind of broken access control, because it survives a basic "did you forget login?" code review. Mutate ranks above read because it produces durable damage; read produces only disclosure.

`idor_vertical_suspicious` ranks lower because it requires human adjudication. A user who's correctly configured `idor.legitimizedHierarchies` should never see this kind unless something in the hierarchy actually broke; an unconfigured run will produce noise here, but the kind name and `requiresAdjudication: true` flag (see § 9) make the noise correctly scoped.

---

## 5. Cluster signature additions

In `cluster/signature.ts`, add three cases. The signature keys on **resourceType**, not toolId, so that two distinct tools (`GET /orders/:id` and `GET /orders/:id/line-items`) operating on the same `orders` resource type cluster as one finding.

```ts
case 'idor_horizontal_read':
case 'idor_horizontal_mutate': {
  const resourceType = detection.idorContext?.resourceType ?? '';
  const tier = detection.idorContext?.tier ?? 'unknown';
  return `${detection.kind}|${resourceType}|${tier}`;
}
case 'idor_vertical_suspicious': {
  const resourceType = detection.idorContext?.resourceType ?? '';
  const sourceTier = detection.idorContext?.sourceTier ?? '';
  const targetTier = detection.idorContext?.targetTier ?? '';
  return `idor_vertical_suspicious|${resourceType}|${sourceTier}->${targetTier}`;
}
```

Two consequences:

- A read that fires on `GET /orders/:id` and on `GET /orders/:id/line-items` (both `resourceType: 'orders'`) is a **single cluster** — one fix likely addresses both routes.
- Cross-tier signatures include the direction (`admin->customer` vs `customer->admin`) so a bidirectional break is visible as two clusters, not one.

The legacy `idor_horizontal` and `idor_vertical_role_escalate` cluster signatures stay unchanged for read-back compatibility.

---

## 6. Fixture-collection mechanism (the trickiest design surface)

The challenge: passively harvest enough ids to mount cross-role swap tests, **without** capturing credentials, presence-only data, or sensitive material that would land in `bugs.jsonl` artifacts.

### 6.1 What gets collected (positive list)

Every `extractIdsFromBody` / `harvestIdsFromDom` call already returns `{ field, value, path }`. v0.21 wraps this with three filters before insertion into `roleFixtures`:

1. **Tool-level deny-list** (path-pattern matches against the calling tool's `path`):
   - `/api/me`, `/api/users/me`, `/api/account`, `/api/profile`, `/api/whoami`, `/api/session` — these return the **caller's own** ids, not other roles' ids. Cross-role replay would test "can role B fetch role B's own profile" which is correct behavior, not IDOR.
   - `/api/auth/*`, `/api/login`, `/api/logout`, `/api/refresh`, `/api/csrf`, `/api/oauth/*` — auth-flow surfaces; ids returned here are session/token state, not resource ids.
   - User-extensible via `idor.skipFixtureFromTools: string[]` (toolId allow-list). Default deny-list ships baked-in.

2. **Field-name deny-list** (extends the existing `ID_NAMES_EXCLUDE` in `resource-id-extractor.ts`):
   - Already excluded: `apikey`, `token`, `secret`, `password`, `sessionid`, `sessiontoken`, `csrftoken`, `authtoken`.
   - v0.21 adds: `verificationcode`, `recoverycode`, `mfa_secret`, `webhook_secret`, `signing_key`, `inviteToken`, `resetToken`, `confirmationToken`.
   - The existing `looksLikeResourceId` value-shape filter (length 1–128, not boolean-string, not `0`/`-1`) stays.

3. **Self-reference filter** (new):
   - For each captured id, compare against the role's own login-identity context. If the id appears in `runState.browserLogin[role].userIdentity` (a pre-computed cache populated at login time from the post-login response), drop it. This catches `/api/orders` returning `{ ownerId: <currentUser>, ... }` — that `ownerId` is the role's own id, not another role's.
   - The cache is best-effort. If `userIdentity` is empty (login response did not surface the user id), skip this filter and rely on the cap below.

4. **Per-(role, resourceType) cap** (new):
   - Default `idor.maxFixturesPerRoleResource: 5`. Once `roleFixtures[role][resourceType]` reaches the cap, additional ids from that role/type combination are dropped on insert. Five distinct ids per role per resource type is enough to cover the swap matrix; any larger and we're over-collecting.

### 6.2 Sources (unchanged from v0.5)

1. **API response bodies** — wired in `phases/execute.ts` after every successful happy-palette call. New filters apply at insert.
2. **DOM scrape** of post-action snapshots — preferred for SPAs where API responses go through client-side state. `data-id` attributes survive.
3. **URL pattern** in collected page links — `harvestIdsFromDom` already extracts `/<entity>/<id-shape>/` segments. v0.21 uses this for resource-type derivation.

### 6.3 Resource-type identification (heuristics + user overrides)

For each id captured, derive a `resourceType: string`. The derivation order:

1. **Config override** — `idor.resourceTypeOverrides: Record<toolId, string>` and `idor.resourceTypeOverridesByPath: Record<urlPattern, string>` (e.g. `{ "/api/v1/orders/:id": "orders" }`). Wins over heuristics.
2. **URL-pattern heuristic** — match the calling tool's `path` against `^/api(?:/v\d+)?/([a-z][a-z0-9-]*)(?:/|$)`. Capture group 1 is the resource type, lowercased, singularised by stripping a trailing `s` if present and the result has length ≥ 3 (so `orders` → `order`, but `news` → `news`, `users` → `user`). Hyphens preserved (`line-items` → `line-item`).
3. **DOM route heuristic** — for ids harvested from URLs (no toolId), the `path` field on `DomHarvestedId` is the URL. Apply the same pattern matching to the URL pathname.
4. **Field-name fallback** — if the path heuristic produces nothing usable, use the field-name root: `tradeId` → `trade`, `customer_id` → `customer`. Strip the trailing `Id`/`_id`/`Uuid` suffix.
5. **Last-resort bucket** — `'_unknown'`. Ids in this bucket are still tested but cluster all together; this is acceptable because a single noisy bucket is easier to triage than a wrong-bucket assignment.

Two ids from different tools that derive to the same `resourceType` participate in the same swap matrix. This is the pivot from v0.5's tool-keyed clustering — a single resource type can be touched by many tools (`GET /orders/:id`, `GET /orders/:id/line-items`, `PATCH /orders/:id`, `DELETE /orders/:id`); they should all be tried with the same fixture set.

### 6.4 Fixture data structure on `RunState`

Add to `RunState`:

```ts
/**
 * v0.21: per-(role, resourceType) fixture ids for cross-role IDOR replay.
 * Derived from `discoveredIds` at the point of the cross-user phase, applying
 * the v0.21 filters and resource-type heuristics. Capped per § 6.1.
 */
roleFixtures?: Map<string, Map<string, Set<string>>>;
//             ^role   ^resourceType  ^id-values
```

The map is built once at the start of `runCrossUser`, reading from `discoveredIds`. It is **not** persisted to `state.json` — the underlying `discoveredIds` is enough to reconstruct on resume. This avoids artifact bloat.

### 6.5 What ends up on disk

Captured fixture ids appear in `bugs.jsonl` only inside `IdorContext.resourceValue`, truncated to the first 12 chars when ≥ 16 chars long. The full id ends up in the action-log artifact (already on disk by virtue of `phases/execute.ts`'s existing artifact pipeline) — that file is per-occurrence and the user already implicitly trusts BugHunter with their dev DB content. We do not write `roleFixtures` to a top-level artifact.

---

## 7. Cross-tier vs peer-tier handling

### 7.1 Tier inference

The v0.5 cross-user phase uses `adminRoleHints: ['admin', 'owner', 'superuser']` to identify admin-tier roles for vertical escalation. v0.21 generalises this to **tiers**.

- `idor.tiers: Record<string, number>` — explicit role-to-tier map. Higher number = higher privilege. e.g. `{ "customer": 0, "support": 1, "admin": 2 }`. Optional.
- Inference fallback: every role matching `adminRoleHints` (substring-insensitive) is tier 1; every other role is tier 0. This preserves v0.5's behavior when `idor.tiers` is unset.

### 7.2 Peer pairs

For the swap matrix:
- **Peer pair**: `tier(roleA) === tier(roleB)`. These run the `idor_horizontal_*` checks.
- **Cross-tier pair**: `tier(roleA) !== tier(roleB)`. These run the `idor_vertical_suspicious` check (suppressed per § 7.3).

Auto-inference produces multiple peer pairs only when there are ≥2 non-admin roles in the run. If the user has roles `["admin", "customer"]`, the **only** pair is cross-tier — peer-tier IDOR can't be tested with that role set, and the run logs a warning: `idor: no peer-tier roles available; horizontal-IDOR pass skipped. Configure idor.peerRoles or add a second non-admin role.`

### 7.3 Legitimized hierarchies

```ts
idor.legitimizedHierarchies: Array<{ from: string; to: string }>
```

When set, a finding where (sourceRole's tier) → (targetRole's tier) matches an entry's `from` → `to` direction is **suppressed entirely** — no detection, no cluster. (Suppressed at classification time, not after; this avoids polluting cluster slot count.)

Example: `[{ from: "admin", to: "customer" }]` means "an admin reading a customer's data is by-design; do not flag." The reverse direction (a customer reading admin's data) would still flag — that's not legitimised.

If the user has not configured `idor.legitimizedHierarchies` and the run produces cross-tier findings, the spec emits `idor_vertical_suspicious` (note the kind name — *suspicious*, not *bug*) and the report's `bugs.jsonl` entry carries `requiresAdjudication: true`. The `/bughunt fix` skill must surface these to the user with a "review and add to legitimizedHierarchies if intended" prompt rather than dispatching to the architect/coder loop. (This is a skill-side concern; v0.21 only supplies the flag.)

### 7.4 Explicit peer pairs override auto-inference

```ts
idor.peerRoles: Array<[string, string]>
```

When set, **only** these pairs are tested as peer-tier; auto-inference is bypassed. Useful for projects with named tiers that don't match the admin-hint heuristic (e.g. `["seller", "buyer"]` — both non-admin in BugHunter's eyes, but conceptually distinct tiers in the app).

If `idor.peerRoles` is set AND `idor.tiers` is set AND a `peerRoles` pair has `tier(A) !== tier(B)`, the explicit `peerRoles` entry wins (peer-tier override) and a warning logs.

---

## 8. Interface contract additions

### 8.1 CLI flags (in `cli/run.ts`)

Add to the `bughunter run` flag list:

```
--idor                  Enable v0.21 IDOR / horizontal-authz pass.
                        Implied by --security. Default: off when neither flag is set.
--no-idor               Disable even when implied by --security.
```

The CLI flag maps to `resolved.idor.enabled = true`; config `idor.enabled` resolves with precedence `flag > config > default`.

### 8.2 Config schema (extends `BugHunterConfig` in `types.ts` + Zod in `config.ts`)

```ts
export type IdorConfig = {
  /** Master switch. True when --security or --idor; false otherwise. */
  enabled?: boolean;
  /** Role-to-tier map. Higher = more privileged. Falls back to adminRoleHints. */
  tiers?: Record<string, number>;
  /** Explicit peer pairs. Overrides auto-inference for the listed pairs only. */
  peerRoles?: Array<[string, string]>;
  /** Cross-tier directions that are by-design; suppressed entirely. */
  legitimizedHierarchies?: Array<{ from: string; to: string }>;
  /** Resource types where cross-role access is intentional (skipped in collect + replay). */
  skipResources?: string[];
  /** ToolIds excluded from fixture collection (extends the baked-in deny-list). */
  skipFixtureFromTools?: string[];
  /** Per-tool resource-type overrides. Wins over heuristics. */
  resourceTypeOverrides?: Record<string, string>;
  /** Per-URL-pattern (glob) resource-type overrides. Wins over heuristic, loses to per-tool. */
  resourceTypeOverridesByPath?: Record<string, string>;
  /** Cap fixtures per (role, resourceType). Default: 5. */
  maxFixturesPerRoleResource?: number;

  /** Cap total swap replays. Default: 400. Distinct from CrossUserConfig.maxReplays. */
  maxReplays?: number;
  /** Probe mutating tools too. Default: false; requires resetPolicy ∈ {transactional, per-test}. */
  probeMutating?: boolean;
};

export type BugHunterConfig = {
  /* ... existing fields ... */
  idor?: IdorConfig;
};
```

### 8.3 `IdorContext` extension (`types.ts`)

```ts
export type IdorContext = {
  sourceRole: string;
  targetRole: string;
  resourceField: string;
  resourceValue: string;
  // v0.21 additions
  resourceType?: string;          // 'order', 'invoice', '_unknown', ...
  mutating?: boolean;             // true for idor_horizontal_mutate
  tier?: 'peer' | 'cross';        // peer-tier or cross-tier replay
  sourceTier?: string;            // '0', '1', or named tier when idor.tiers is set
  targetTier?: string;
  /** Set when this finding requires user adjudication. Drives the skill UX. */
  requiresAdjudication?: boolean; // true for idor_vertical_suspicious
};
```

### 8.4 Telemetry on `summary.json`

```ts
idor?: {
  enabled: boolean;
  fixturesCollected: Record<string, Record<string, number>>;
  // ^role   ^resourceType  ^id count (capped at maxFixturesPerRoleResource)
  swapsAttempted: number;
  swapsByPair: Array<{ from: string; to: string; count: number }>;
  detectionsByKind: {
    idor_horizontal_read: number;
    idor_horizontal_mutate: number;
    idor_vertical_suspicious: number;
  };
  suppressedByLegitimizedHierarchy: number;
  skippedReasons: Array<{ reason: string; count: number }>;
  durationMs: number;
};
```

---

## 9. Edge cases

### EC-1. Read-only resources legitimately shared (product catalog, public events feed)
A `GET /products/:id` hit by every role legitimately returns 200 with the same row. Without configuration, this fires `idor_horizontal_read` for every (role A, role B) peer pair. Mitigation: `idor.skipResources: ["products"]` suppresses both collection and replay for that resource type. Document as the v0.21 default-paranoid stance: prefer false positives the user explicitly silences over false negatives.

### EC-2. Soft-deleted resources
Role A creates order #123, deletes it; id stays in `roleFixtures`. Role B's swap returns `200 { ...soft-deleted record }` because soft-delete doesn't filter by ownership in the gate path. v0.21 still fires `idor_horizontal_read` — soft-deleted records should be invisible to non-owners regardless.

### EC-3. Tenant-scoped roles where every role is its own tenant
On apps where customerA's id namespace is fully disjoint from customerB's (compound `tenantId-orderId` keys), the swap returns 404 because the id doesn't exist in tenant B's space. v0.21 logs `skipped: cross_tenant_namespace_distinct` per § 2.2; richer modeling deferred to v0.22.

### EC-4. Rate limiting masking IDOR as 429
The cross-role loop hits the same endpoint repeatedly; some apps return 429 from the second hit. v0.21 classifier returns null on 429 (the gate did not run); runner pauses for `Retry-After` (or 30s default). Counted under `swapsThrottled`, not as a finding. Borrows v0.16 § 3.1 rate-limit honoring.

### EC-5. Mutating swap actually mutates (`probeMutating: true`)
A `DELETE /orders/:id` swap that succeeds destroyed role A's fixture. `probeMutating: true` is gated by `resetPolicy ∈ {'transactional', 'per-test'}`. Runner aborts the v0.21 pass with `skipped: mutating_probe_requires_reset_policy` otherwise. Roll-back semantics inherited from `resetPolicy`.

### EC-6. Echoed id in 4xx body (e.g. "Order not found: <id>")
Classifier fires only on 2xx; 4xx echoes are not findings.

### EC-7. Empty 200 body
Existing `isEmptyResult` in `cross-user.ts` already handles `null`/`{}`/`[]`/`{data: null}`. Reused; empty 200 is not a finding.

### EC-8. 302 redirect to role B's own equivalent resource
Correctly-gated route. v0.21 inherits v0.5's no-auto-follow behavior; 3xx is not a finding.

### EC-9. Opaque signed-URL tokens (JWT-shaped, signature query params)
Signed URLs authorize the holder, not the role; cross-role swap tests the wrong invariant. Any captured value > 64 chars containing a `.` (JWT-shape) or appearing alongside `?signature=` is dropped at collection. Add to `skippedReasons.opaque_signed_token`.

### EC-10. Pagination cursors / etag-style ids
Harvester captures once; may be stale by swap time. Swap returns 404; classifier returns null. Acceptable false-negative.

### EC-11. Same resourceType reachable via two URL prefixes (`/api/orders/:id` and `/v2/orders/:id`)
Both derive the same `resourceType: 'order'`; both contribute fixtures and get probed. Cluster signature collapses correctly.

### EC-12. Legacy v0.5 cross-user phase still runs alongside
`config.crossUser` and `config.idor` are independent. Default (v0.21 disabled): only legacy v0.5 runs. With `--idor`: the v0.21 classifier supersedes the v0.5 emit path inside `cross-user.ts` — a single replay produces at most one detection. Implementation: one switch on `config.idor.enabled` selects which path emits. Both cannot fire together.

### EC-13. SurfaceMCP does not annotate `requiresAuth`
v0.21 does not depend on `requiresAuth`; the mutate/read split derives from `sideEffectClass: 'mutating'` vs `'safe'`. `'external'` tools are skipped (v0.5 already skips them).

---

## 10. Acceptance criteria

1. `npx tsc --noEmit` clean.
2. `npx eslint . --max-warnings 0` clean.
3. `npx vitest run` green. New unit coverage:
   - `classifyIdorOutcome` returns the three new kinds correctly across the (peer/cross-tier × safe/mutating × empty/non-empty body × 2xx/4xx/5xx/429) matrix.
   - `deriveResourceType` handles config overrides, URL-pattern heuristic, DOM-route fallback, field-name fallback, and `_unknown` last resort.
   - The deny-list in `extractIdsFromBody` skips the new fields (`verificationcode`, `recoverycode`, `mfa_secret`, etc.).
   - The tool-deny-list skips ids from `/api/me`, `/api/auth/*`, etc.
   - `idor.legitimizedHierarchies` suppresses cross-tier findings exactly matching the configured `from→to`.
   - Cluster signature for `idor_horizontal_read` collapses two distinct toolIds with the same resourceType into one cluster.
   - `idor.peerRoles` overrides auto-inference; `idor.tiers` is consulted before admin-hint fallback.
   - `idor.maxFixturesPerRoleResource` cap is honored on insert.
4. **Synthetic vulnerable fixture**: extend `fixtures/pen-bad/` (or new `fixtures/idor-bad/`) with a deliberately broken horizontal-authz route: `GET /orders/:id` that loads by id without ownership check. Smoke run with two peer-tier roles produces ≥1 `idor_horizontal_read` cluster with the correct `resourceType: 'order'`.
5. **Synthetic mutate fixture**: same fixture with a `DELETE /orders/:id` route lacking ownership check. With `probeMutating: true` and `resetPolicy: 'transactional'`, smoke produces ≥1 `idor_horizontal_mutate` cluster.
6. **Synthetic vertical fixture**: an admin-only route that legitimately returns customer data; with `idor.legitimizedHierarchies: [{from: "admin", to: "customer"}]`, zero `idor_vertical_suspicious` findings; without the entry, ≥1 finding.
7. **Negative smoke (TraiderJo, Aspectv3)**: with `--idor` enabled, zero v0.21 findings expected (assuming both apps gate horizontal access correctly). If findings appear, they're either real bugs (file them) or expose configuration gaps (`idor.skipResources` for shared catalog rows).
8. `summary.json.idor` block populated with telemetry per § 8.4.
9. Existing v0.5 cross-user tests continue to pass (legacy `idor_horizontal` / `idor_vertical_role_escalate` kinds still serializable).

---

## 11. Files to touch / add

### 11.1 Modify

| File | What |
|---|---|
| `packages/cli/src/types.ts` | Add three `BugKind` variants; extend `IdorContext`; add `IdorConfig` and `BugHunterConfig.idor`; add `RunState.roleFixtures`. |
| `packages/cli/src/config.ts` | Zod schema for `IdorConfig` (refinement: `legitimizedHierarchies[].from !== .to`). |
| `packages/cli/src/cluster/signature.ts` | Three new cases per § 5. |
| `packages/cli/src/phases/classify.ts` | Insert three kinds into `KIND_PRIORITY` per § 4.3. |
| `packages/cli/src/phases/cross-user.ts` | Wire v0.21 classifier branch (gated on `config.idor?.enabled`); derive `roleFixtures`; add (resourceType, mutating tool) iteration when `probeMutating`; honor all config knobs from § 8.2. |
| `packages/cli/src/phases/cross-user.test.ts` | Mirror new tests per § 10.3. |
| `packages/cli/src/security/resource-id-extractor.ts` | Extend `ID_NAMES_EXCLUDE` (§ 6.1 step 2); opaque-signed-token guard (EC-9). |
| `packages/cli/src/cli/run.ts` | `--idor` / `--no-idor` flags; resolve `idor.enabled`. |
| `packages/cli/src/phases/emit.ts` | Populate `summary.json.idor` from runner telemetry. |
| `packages/cli/src/cli/inspect.ts` | Display deprecated `idor_horizontal` / `idor_vertical_role_escalate` with a "v0.21 supersedes" banner. |

### 11.2 Create

| File | Purpose |
|---|---|
| `packages/cli/src/security/resource-type.ts` | Pure `deriveResourceType(toolMeta, idValue, config) → string`. |
| `packages/cli/src/security/resource-type.test.ts` | Unit tests for heuristic + override cascade. |
| `packages/cli/src/security/idor-classifier.ts` | Pure `classifyIdorOutcome(...)` per § 3.3. |
| `packages/cli/src/security/idor-classifier.test.ts` | Tests for the classifier matrix. |
| `fixtures/idor-bad/` | Synthetic vulnerable Express app with horizontal-read, horizontal-mutate, and legitimately-vertical routes; mirrors `fixtures/pen-bad/`. |
| `tests/integration/idor-smoke.test.ts` | End-to-end run against `fixtures/idor-bad/` verifying one cluster per intended bug. |

### 11.3 Documentation

Update `SPEC.md` § 3.5 (classification table), § 3.5.1 (priority hierarchy), and § 8 (config schema) to reference the new kinds and the `idor` block. No new top-level command.

---

## 12. Definition of Done

```
cd /tmp/idor-bad-fixture        # synthetic vulnerable app from § 11.2
node packages/cli/dist/cli/main.js init
# config.idor.enabled = true; config.idor.peerRoles = [["alice","bob"]];
# config.idor.tiers = { "alice": 0, "bob": 0, "admin": 1 };
# config.idor.legitimizedHierarchies = [{ from: "admin", to: "alice" }];
# config.idor.probeMutating = true; config.resetPolicy = "transactional";
node packages/cli/dist/cli/main.js run --idor
```

…produces:
- `bugs.jsonl` containing exactly:
  - One `idor_horizontal_read` cluster with `resourceType: 'order'` (from the broken `GET /orders/:id`).
  - One `idor_horizontal_mutate` cluster with `resourceType: 'order'` (from the broken `DELETE /orders/:id`).
  - Zero `idor_vertical_suspicious` clusters (the admin→alice path is legitimised).
- `summary.json.idor.fixturesCollected.alice.order` reports between 1 and 5 (capped) ids harvested from alice's authenticated walk.
- `summary.json.idor.swapsAttempted` ≥ 4 (alice→bob × {read, mutate} + bob→alice × {read, mutate}).
- `summary.json.idor.suppressedByLegitimizedHierarchy` ≥ 1 (the admin→alice cross-tier swap that would otherwise have fired).
- The cluster signatures collapse `GET /orders/:id` and `GET /orders/:id/line-items` into a single `idor_horizontal_read|order|peer` cluster (when both routes share the gate bug).

…and against TraiderJo / Aspectv3 with `--idor`:
- Zero `idor_horizontal_*` findings (both apps gate ownership correctly).
- `idor_vertical_suspicious` findings only when `legitimizedHierarchies` is unset; configuring it produces zero findings.
- No regression in v0.5 cross-user metrics; legacy `idor_horizontal` cluster count is zero (replaced) but `auth_bypass_via_unauthed_route` continues firing on the existing TraiderJo bypass surface.

---

## 13. Open questions

1. **Resource-type singularisation** (§ 6.3 step 2): should `users` → `user`, `news` → `news` (no change because length ≤ 3 after strip), `series` → `series`? The proposed rule strips trailing `s` only when `len(stem) ≥ 3`, but English has irregulars. Defer to user-overrides via `idor.resourceTypeOverridesByPath` rather than ship a heavier inflector. Confirm this minimal rule is acceptable.

2. **Cross-tier direction symmetry**: is `idor_vertical_suspicious` always emitted when `tier(A) !== tier(B)` and the response is 2xx, regardless of direction? Today's spec says yes. Alternative: only emit on the **lower→higher** direction (which is closer to a real escalation), and fold higher→lower into a separate `idor_vertical_data_disclosure` kind. The user requirement specifically called out "admin sees customer data" as the canonical vertical case, so the spec keeps direction-agnostic for now; revisit if telemetry shows lower→higher is the dominant signal.

3. **Mutating swap rollback granularity**: § 9 EC-5 gates `probeMutating` behind `resetPolicy ∈ {'transactional', 'per-test'}`. Is `'per-page'` also acceptable? Probably not — a horizontal-mutate swap doesn't end the page. But for read-mostly apps with cheap per-page reset, the reset would still trigger after the page boundary. Conservative answer: require `'transactional'` or `'per-test'`. Confirm.

4. **Should `idor_vertical_suspicious` clusters bypass the `--max-bugs` cap**? They require human adjudication, not a fix; flooding the cap with adjudication tickets pushes real bugs out. Argument for a separate sub-cap (`idor.maxAdjudicationClusters`, default 50). Defer to v0.22 unless the synthetic fixture run shows volume.

5. **Auto-detect peer-tier from session response shape**: SurfaceMCP could expose a `tier` field per role from project config. Today's `idor.tiers` is user-supplied; should v0.21 fall back to a `surface_describe_role(role) → { tier?: number }` if SurfaceMCP starts surfacing it? Defer; not in v0.21 scope.

6. **Cluster-signature stability across runs when resourceType derivation changes**: if a v0.22 user changes `idor.resourceTypeOverridesByPath`, the cluster signature shifts and old artifacts no longer match. Acceptable because cluster-signature stability is best-effort across config changes (same caveat as `errorMessageNormalized` regex tweaks).

7. **Should `idor.skipFixtureFromTools` also skip tools whose `path` matches a glob, not just exact toolIds**? Probably yes; cleaner UX. Spec ships exact-toolId form; v0.22 can extend.
