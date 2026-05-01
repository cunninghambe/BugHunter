# SPEC — v0.32 "Deterministic mode (--seed / --frozen-clock / --frozen-network)"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-30 · **Predecessor:** SPEC_PATH_TO_EXHAUSTIVE.md §6.1, §9 Phase C ("trust") · **Depends on:** **V23** (frozen-clock browser polyfill via init-script — coordinate; this spec assumes V23's `installFrozenClock(scope, isoTime)` helper exists), **V20** (network-fault adapter / camofox `network_fault` MCP tool — used as the request-interception primitive for HAR replay) · **Sibling:** none.

This spec lifts BugHunter from "runs produce *similar* output" to "runs produce **byte-identical** `bugs.jsonl` given identical inputs." That is the prerequisite for every downstream trust claim in §6 of the path-to-exhaustive spec: cross-run diff, regression bisect, public benchmark numbers, BugHunter-on-BugHunter self-test, and CI gates that fail-on-regression rather than fail-on-noise. Without this, every `bughunter diff <old> <new>` reports phantom changes (timestamp drift, cuid drift, cluster-order drift, network-jitter drift) and the engineer learns to ignore the diff. With this, a green diff means a green diff.

---

## 1. Objective

Add three CLI flags to `bughunter run` that, when used together, make a run reproducible:

| Flag | Pins |
|---|---|
| `--seed <n>` | All locally-minted random sources: cuid2 ids (runId, testId, occurrenceId, clusterId), the few `Math.random()` direct sites, and the (future V39) fuzz generators. |
| `--frozen-clock <iso8601>` | All timestamps emitted into `bugs.jsonl` and `summary.json`: cluster `firstSeenAt`/`lastSeenAt`, occurrence `timestamp`, run `startedAt`, log lines (when redirected to a file). Browser-side `Date.now()` and `new Date()` via V23's init-script polyfill. CDP wall-clock timestamps via offset translation. |
| `--frozen-network <path>` | All outbound HTTP from the browser (camofox tabs) and the CLI (vision client, surface-mcp probes). First run with `--record-network <path>` writes a HAR; subsequent runs with `--frozen-network <path>` replay. |

**Acceptance target:** `bughunter run --seed 1234 --frozen-clock 2026-05-01T12:00:00.000Z --frozen-network fixtures/aspectv3.har <dir>` produces a `bugs.jsonl` whose SHA-256 matches across two consecutive invocations. CI test enforces this against the `fixtures/bughunter-self-deliberate-bugs/` fixture (created in §6.2 of the path-to-exhaustive spec; not blocked on it — V32 ships its own minimal fixture for the CI test).

**In scope:**
- Three new flags in `RunOptions` + `main.ts` flag wiring + `run.ts` propagation.
- A seeded id factory replacing the bare `createId()` import in 8 call sites.
- A frozen-clock seam in `nowIso()` / `nowMs()` helpers replacing direct `new Date().toISOString()` and `Date.now()` in run-emitted artifacts (NOT in budget/deadline math, which stays wall-clock).
- HAR record/replay layer at the camofox-mcp boundary using V20's `network_fault` MCP tool for replay and a passthrough+record adapter for capture.
- Canonical ordering of `bugs.jsonl` lines by `signatureKey` ASC (insertion order today is concurrency-dependent; must sort before emit).
- Stable `JSON.stringify` key ordering in cluster + summary JSON via a sorted-keys serializer for the `bugs.jsonl` and `summary.json` writers only.
- A non-determinism inventory (table, exhaustive, file:line per source).
- A CI test that asserts byte-identical `bugs.jsonl` across two runs.

**Out of scope (deferred):**
- **Distributed-system reproducibility.** If the *target app* is itself non-deterministic (calls `new Date()`, generates uuids server-side and returns them in a body, ML inference), HAR replay stabilizes the bytes but the bug-set may still be a function of the recorded snapshot's content. Document in §11 — record once, replay always.
- **Vision LLM determinism beyond HAR.** Anthropic's API isn't byte-deterministic at the model layer; HAR replay pins the exact bytes returned at the previous record time, which is sufficient. We do NOT call the live model in deterministic mode.
- **Browser process determinism.** Camofox/Firefox itself has timing jitter (compositor, GC). Layout-shift / INP measurements are excluded from determinism guarantees — see §5 EC-7.
- **Multi-machine reproducibility.** Two machines with different CPU clocks can produce different perf numbers even with frozen-clock. Acceptance is *same-machine, same-tooling*. Cross-machine is a Phase F calibration concern, not V32.
- **`--seed` without `--frozen-clock`.** Permitted as a partial-determinism mode (cuid2 ids stable, timestamps still wall-clock). Acceptance does NOT require byte-identity in this mode; it requires structural identity (same number of clusters, same kinds, same signatures). §6.4 covers this.
- **Replay of camofox launches/profile creation.** Browser profile state is created fresh per run; we don't snapshot it.

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/cli/main.ts` (lines 130-156) | Where CLI flags are parsed and forwarded into `RunOptions`. Add three flags here. |
| `packages/cli/src/cli/run.ts` (lines 47-95: `RunOptions`; lines 191-202: runId minting) | Where `RunOptions` is declared and the run boots. Wire the seed/clock/network through here. |
| `packages/cli/src/store/run-state.ts` (line 28-32: `initRunState`) | `startedAt` timestamp — replace with `nowIso(opts)`. |
| `packages/cli/src/phases/cluster.ts` (lines 7, 64-65, 79-81, 108) | Heaviest concentration of `createId()` and `new Date()`. Cluster ordering before emit lives here (line 140 `Array.from(clusterMap.values())` — must sort by signatureKey). |
| `packages/cli/src/phases/emit.ts` | Where `bugs.jsonl` is appended (line 49). Lines must be sorted upstream; emit must use canonical-keys JSON serializer. |
| `packages/cli/src/phases/execute.ts` (lines 38, 234-235, 313, 481, 503, 609, 628, 795-796, 818-820, 837, 868-870, 889-891, 977-979) | Massive `createId()` + `Date.now()` + `new Date()` density. Surgical replacement. |
| `packages/cli/src/phases/cross-user.ts` (lines 4, 120, 217, 304, 363-365) | createId + new Date. |
| `packages/cli/src/phases/race-runner.ts` (lines 10, 40-41, 65-67, 80, 117) | createId + Date.now + raceNonce. The raceNonce is user-visible in xss canaries — seed it. |
| `packages/cli/src/phases/auth-flow.ts` (lines 5, 133, 176, 186-187, 196, 245) | The two **direct** `Math.random()` sites for temp passwords. Replace with seeded RNG. |
| `packages/cli/src/mutation/apply.ts` (lines 5, 33, 66, 88, 253, 282) | createId for every test case. |
| `packages/cli/src/mutation/palette.ts` (line 83) | `new Date().toISOString().slice(0, 10)` for the `date` palette `happy` variant — must use frozen-clock when set. |
| `packages/cli/src/store/filesystem.ts` (line 73 `fs.readdirSync`) | Filesystem walk order is OS-dependent. Sort before iterating where the result feeds into determinism-relevant output. |
| `packages/cli/src/static/bundle-analyzer.ts` (line 70 `fs.readdirSync`) | Same. |
| `packages/cli/src/phases/analyze.ts` (line 126 `fs.readdirSync`) | Same. |
| `packages/cli/src/adapters/cdp-session.ts` (lines 123, 237, 316) | CDP `Date.now()` for capture timestamps. These feed HAR via `harEntriesToNetworkRequests`. Translate via clock offset OR fold under HAR replay (preferred). |
| `packages/cli/src/adapters/har-writer.ts` | HAR shape. The `_bughunter` private field has a `requestId` — must be deterministic (already counter-based per session; verify). |
| `packages/cli/src/adapters/browser-mcp.ts` (line 65 `navigate`, line 397 `evaluate`) | Camofox MCP entry points. The clock-polyfill init-script (V23) must be installed via `evaluate` immediately after every `navigate`. The HAR-replay handler attaches at adapter construction. |
| `packages/cli/src/log.ts` (line 15: `new Date().toISOString()`) | Log timestamps. When `--frozen-clock` is set AND log output is captured to a run-artifact file, use `nowIso(opts)`. Stderr/stdout are not deterministic targets — only the log file. |
| `SPEC_PATH_TO_EXHAUSTIVE.md` §6.1, §9 Phase C | Source of truth for the determinism mandate. Read first. |
| `SPEC_V18_JWT_LOGIN_VERIFY.md` | V-spec format reference. **Match this structure section-for-section.** |
| `SPEC_V19_RACE_CONDITIONS.md` | Same V-spec format; second reference. |

### 2.2 Patterns to follow

- **Discriminated union for clock mode.** `type ClockMode = { kind: 'wall' } | { kind: 'frozen', isoTime: string, ms: number }` — passed through phases via `RunOptions.clock`. Avoid an `isFrozen?: boolean` + a separate `frozenIso?: string` pair; one field, exhaustively narrowed.
- **Factory injection over global mutation.** Do **not** monkey-patch `Math.random` globally. Build a `DeterministicContext` carrying `{ rng, idFactory, now }` and pass it explicitly. Globals make tests order-dependent and break parallel test execution.
- **Existing helper expansion.** `nowIso(ctx)` and `nowMs(ctx)` go in `packages/cli/src/lib/clock.ts` (new). One concern, ~30 lines, no transitive deps.
- **Cuid2's `init` is the right seam.** The package exports `init({ random, counter, fingerprint })` (verified — `node_modules/@paralleldrive/cuid2/src/index.js`). Construct one per run from the seeded RNG; export `idFactory.createId()` as the project-wide id source.
- **HAR replay via `network_fault`.** V20 added the camofox `network_fault` MCP tool which fulfils requests with a body. We extend the same call: `network_fault(url, { mode: 'replay', har: <parsed-entries> })`. Falls through to network on miss when `--frozen-network` is set with `--allow-network-miss` (default: hard-fail on miss).
- **Sorted JSONL output.** `runEmit` sorts clusters by `signatureKey` ASC before append, and uses `canonicalStringify(cluster)` (recursive sorted keys) instead of `JSON.stringify`.

### 2.3 DO NOT

- Do **not** seed `Math.random` globally. Inject a seeded RNG; pass it where needed.
- Do **not** replace `Date.now()` in budget/deadline math. `executeOptions.deadline = Date.now() + maxRuntimeMs` MUST use wall-clock; freezing it would mean the run never times out. Only the *emitted* timestamps in artifacts get frozen.
- Do **not** parse the HAR with a heavy dep. Use the existing `har-writer.ts` shape and a small parser (~50 lines).
- Do **not** record HAR responses for vision when the user has not consented — vision API responses contain prompts and are subject to redaction. Document; redact `Authorization` headers from recorded HARs at write time.
- Do **not** introduce a new id format. Stay on cuid2 — only swap the entropy source.
- Do **not** make `--seed` imply `--frozen-clock`. They are independent and orthogonal; users can opt-in piecewise.
- Do **not** sort `bugs.jsonl` by anything other than `signatureKey`. Other orderings (kind-priority, cluster-size) are presentation concerns and belong in `bughunter list`, not the canonical artifact.
- Do **not** emit any timestamp with sub-millisecond precision. Drop nanoseconds; ISO 8601 millisecond precision is the floor and the ceiling.
- Do **not** allow `--frozen-network` to silently fall through to live network on a miss. Default to hard-fail; require `--allow-network-miss` to opt out. Silent fall-through is the worst kind of non-determinism — a flake the user can't see.

---

## 3. Architecture decisions per flag

### 3.1 `--seed <integer>`

**Decision: PRNG = mulberry32 (32-bit state, 32-bit output, period 2³², ~10 lines).** Sufficient for ID generation; not crypto. Rationale: zero-dep, byte-deterministic, well-tested, fast enough.

```ts
// packages/cli/src/lib/rng.ts (new)
export function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6D2B79F5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 0x100000000;
  };
}
```

**Cuid2 seam:** `cuid2.init({ random: rng, counter: createCounter(0), fingerprint: 'bh-deterministic' })` — fingerprint is fixed string (NOT host-based). Counter starts at 0 (NOT `floor(rng() * initialCountMax)` — eliminates one entropy round, keeps determinism cleaner).

**The eight `import { createId } from '@paralleldrive/cuid2'` sites become** `import { createId } from '../lib/ids'` — that file re-exports either the seeded factory's createId (when seeded) or cuid2's default (when unseeded). The factory is constructed once at run-start in `runCommand` and stored on a module-local singleton via `setIdFactory(factory)`. Yes, this is a global. It's the smallest one we can get away with; alternative is threading the factory through every phase signature, which is 70+ touch sites.

**Math.random() direct sites:** the two in `auth-flow.ts:186-187` (temp passwords). Replace with `seededRng()` from the same RNG context.

**Test fixture sites:** `request-hygiene.test.ts:43` uses `Math.random()` — this is a test, so it's not in the determinism path. Leave alone but document.

### 3.2 `--frozen-clock <iso8601>`

**Decision: build on V23's browser-side polyfill; add a CLI-side `Clock` abstraction.**

```ts
// packages/cli/src/lib/clock.ts (new)
export type Clock =
  | { kind: 'wall' }
  | { kind: 'frozen'; isoTime: string; ms: number };

export function makeClock(opts: RunOptions): Clock {
  if (opts.frozenClock === undefined) return { kind: 'wall' };
  const ms = Date.parse(opts.frozenClock);
  if (Number.isNaN(ms)) {
    throw new Error(`--frozen-clock: invalid ISO 8601: ${opts.frozenClock}`);
  }
  return { kind: 'frozen', isoTime: new Date(ms).toISOString(), ms };
}

export function nowIso(clock: Clock): string {
  return clock.kind === 'frozen' ? clock.isoTime : new Date().toISOString();
}

export function nowMs(clock: Clock): number {
  return clock.kind === 'frozen' ? clock.ms : Date.now();
}
```

The frozen variant is **strictly constant** during a run — it does not advance. This is correct because clusters' `firstSeenAt` and `lastSeenAt` would otherwise diverge by milliseconds across runs (even with frozen network, the order of `Promise.race(inFlight)` resolution is not guaranteed across runs at sub-millisecond resolution). With strictly-constant frozen time, both timestamps collapse to the same string.

**Browser-side polyfill (V23 dependency):** after every `navigate`, run `installFrozenClock(scope, clock.isoTime)` from V23. That helper installs:
- `Date.now = () => <fixed ms>`
- `new Date() = new originalDate(<fixed ms>)`
- `new Date(arg) = original` (only no-arg construction is frozen)
- `performance.now = () => <fixed offset>`

If V23 has not landed when V32 implementation begins, V32's coder must stub `installFrozenClock` to a no-op and ship the CLI-side determinism; browser-side is gated on V23. Document the gating in the kickoff handoff.

**Budget/deadline math:** uses `Date.now()` directly, not `nowMs(clock)`. The deadline is *real* — a frozen clock would never time out.

**Log lines:** `log.ts:15` writes wall-clock. Two strategies:
1. Always use wall-clock for log lines (they go to stderr, not artifacts; non-deterministic by design).
2. When `clock.kind === 'frozen'` AND a `--log-file <path>` is specified (future), use `nowIso(clock)` for the file lines.
Pick (1) for V32. Log files are not in the determinism contract.

### 3.3 `--frozen-network <path>` + companion `--record-network <path>` + `--allow-network-miss`

**Decision: HAR 1.2 is the format. Two-mode adapter.**

The existing `har-writer.ts` already produces HAR 1.2 from CDP. V32 adds:

```ts
// packages/cli/src/adapters/har-replay.ts (new, ~120 lines)
export type NetworkMode =
  | { kind: 'live' }
  | { kind: 'record'; harPath: string }
  | { kind: 'replay'; harPath: string; allowMiss: boolean };

export interface HarReplayer {
  /** Match a request to a recorded entry. Return undefined for miss. */
  match(req: { method: string; url: string; body?: string }): HarEntry | undefined;
  /** Number of entries in the HAR. */
  size(): number;
  /** Entries not yet matched (for end-of-run audit). */
  unmatched(): HarEntry[];
}
```

**Capture path (`--record-network`):**
- Live network is allowed.
- Every observed request → response pair is appended to the HAR file at run-end (`runEmit` extension).
- Vision API requests are recorded with `Authorization` header redacted (replace value with `***REDACTED***`); replay tolerates redaction.

**Replay path (`--frozen-network`):**
- The camofox adapter intercepts every request via V20's `network_fault` tool, with the new mode `replay`.
- Match key is `(method, normalizedUrl, normalizedBody?)`. Normalizer strips query parameters declared in `[harPath].normalize.json` (sibling file, optional) — covers cache-busters and timestamps in URLs. Body normalization is stringified-JSON-with-sorted-keys.
- Miss: hard-fail with `network_replay_miss` infrastructure failure unless `--allow-network-miss` is set.
- Unmatched-entries audit: emit `summary.json.networkReplay = { matched, missed, unmatchedRecorded }`.

**Vision client integration:** `AnthropicVisionClient` gets a constructor param `httpFetch?: (url, init) => Promise<Response>`. In replay mode, an injected fetch consults the HAR replayer first.

**Surface MCP probes / header probes / form-reachability probes:** these use the local `fetch()`. Wrap the same way — accept an injected fetch in replay mode.

---

## 4. Non-determinism inventory

Exhaustive table of every source of non-determinism affecting `bugs.jsonl` or `summary.json`. Each must be pinned by one of: `--seed`, `--frozen-clock`, `--frozen-network`, or canonical sort.

| # | Source | File:line | Strategy |
|---|---|---|---|
| 1 | `createId()` (cuid2) — runId | `cli/run.ts:198` | `--seed` (seeded cuid2 factory, fingerprint='bh-deterministic') |
| 2 | `createId()` — testId | `cli/run.ts:604,695,735`; `mutation/apply.ts:33,66,88,253,282`; `phases/auth-flow.ts:133,176,196,245`; `phases/cross-user.ts:120,217,304`; `phases/execute.ts:235,313,479,503,609,628,837,977`; `phases/race-runner.ts:41,65`; `phases/plan.ts:*` | `--seed` (same factory) |
| 3 | `createId()` — occurrenceId | `cli/run.ts:605,696,736`; `phases/execute.ts:235,479,503,609,628,795,837,868,977`; `phases/race-runner.ts:41` | `--seed` |
| 4 | `createId()` — clusterId | `phases/cluster.ts:81` | `--seed` |
| 5 | `createId()` — synthetic clusters | `cli/run.ts:774` | `--seed` |
| 6 | `Math.random()` — temp password 1 | `phases/auth-flow.ts:186` | `--seed` (use seeded rng directly) |
| 7 | `Math.random()` — temp password 2 | `phases/auth-flow.ts:187` | `--seed` |
| 8 | `Math.random()` — request id (TEST ONLY) | `classify/request-hygiene.test.ts:43` | not in determinism path; leave |
| 9 | `new Date().toISOString()` — log line | `log.ts:15` | not in determinism contract (stderr/stdout); leave |
| 10 | `new Date().toISOString()` — startedAt | `store/run-state.ts:32` | `--frozen-clock` (`nowIso(clock)`) |
| 11 | `new Date().toISOString()` — execute timestamps (×9) | `phases/execute.ts:315,481,505,611,630,818,839,889,979` | `--frozen-clock` |
| 12 | `new Date().toISOString()` — cluster firstSeen/lastSeen | `phases/cluster.ts:79,108` | `--frozen-clock` |
| 13 | `new Date().toISOString()` — cross-user | `phases/cross-user.ts:363` | `--frozen-clock` |
| 14 | `new Date().toISOString()` — race | `phases/race-runner.ts:67` | `--frozen-clock` |
| 15 | `new Date().toISOString()` — synthetic cluster firstSeen/lastSeen | `cli/run.ts:772,790` | `--frozen-clock` |
| 16 | `new Date().toISOString()` — artifact-budget log | `store/artifact-budget.ts:75` | `--frozen-clock` |
| 17 | `new Date().toISOString().slice(0,10)` — date palette `happy` | `mutation/palette.ts:83` | `--frozen-clock` |
| 18 | `Date.now()` — execute deadline | `phases/execute.ts:114` | NOT pinned — wall-clock by design |
| 19 | `Date.now()` — durationMs in test results | `phases/execute.ts:328,488,512,618,637,773,846,967,986`; `phases/race-runner.ts:61,80`; `phases/form-submit-runner.ts:205` | NOT in determinism contract — duration varies by machine; we exclude `durationMs` from canonical hash (see §5 EC-2) |
| 20 | `Date.now()` — header probe duration | `security/header-probe.ts:27,46` | NOT pinned (duration excluded) |
| 21 | `Date.now()` — CDP timestamps | `adapters/cdp-session.ts:123,237,316` | covered by HAR replay (response timing comes from recorded HAR) |
| 22 | `Date.now()` — observer timing | `classify/state-change.ts:55,65` | duration is observation-window — exclude from canonical hash |
| 23 | `Date.now()` — polling deadlines | `discovery/browser-login.ts:370,553`; `phases/form-reachability-probe.ts:52,89,100,142` | NOT pinned (real timing) |
| 24 | `fs.readdirSync` — runs dir | `store/filesystem.ts:73` | sort ASC before consume (lexicographic) |
| 25 | `fs.readdirSync` — heap dir | `phases/analyze.ts:126` | sort ASC |
| 26 | `fs.readdirSync` — bundle dir | `static/bundle-analyzer.ts:70` | sort ASC |
| 27 | `Map<sig, BugCluster>` insertion order | `phases/cluster.ts:64,140` | canonical sort by `signatureKey` ASC before emit |
| 28 | `results.push(result)` order — concurrent UI/API drains | `phases/execute.ts:348` | Insertion-order non-deterministic. Mitigation: clusters absorb any test-order in `runCluster` → `clusterMap.get(sig)`; per-cluster occurrences are then sorted by `(occurrenceId)` ASC before emit. |
| 29 | `Object.entries`, `Object.keys` JSON output ordering | many sites | canonical-keys serializer for `bugs.jsonl` and `summary.json` |
| 30 | Network responses (vision, surface, target app) | network layer | `--frozen-network` (HAR replay) |
| 31 | Vision LLM nondeterminism beyond bytes | `adapters/vision-client.ts` | live mode forbidden under `--frozen-network`; HAR replay returns recorded bytes verbatim |
| 32 | `raceNonce = createId()` | `phases/race-runner.ts:117` | `--seed` (downstream of seeded factory) |
| 33 | Browser-side `Date.now()` / `new Date()` (e.g. axe-core, web-vitals timestamps in artifacts) | runs inside `evaluate()` in target page | `--frozen-clock` via V23's `installFrozenClock` init-script |
| 34 | Browser-side `Math.random()` (web-vitals UMD line 1, target app) | injected scripts and target app | NOT pinned (target app is a black box; if its randomness produces different DOM, the bug-set legitimately differs — V32 doesn't try to override target). Document. |
| 35 | OS / FS mtime in `pruneRuns` | `store/filesystem.ts:80` | not in `bugs.jsonl` path |
| 36 | Process pid, hostname, env vars in logs/summary | various | not emitted into `bugs.jsonl`; verify `summary.json` doesn't leak any (audit task) |

**Sources marked NOT pinned** are excluded from the canonical-bytes contract via the **canonical hash recipe** in §6.5 (which excludes `durationMs`, observation-window numbers, and any field documented as wall-clock-derived).

---

## 5. Edge cases

### EC-1. `--seed` without `--frozen-clock`
Permitted. cuid2 ids stable; timestamps still wall-clock. Acceptance: structural identity (same cluster count, same kinds, same signatures), NOT byte identity. CI runs this mode as a separate test — see §6.4.

### EC-2. `durationMs` differs across runs
Expected. `durationMs` is wall-clock-derived; identical recorded network does NOT mean identical wall time on this machine. The canonical hash (§6.5) strips `durationMs`, `actualRuntimeMs`, `projectedRuntimeMs`. CI tests verify these are absent from the hashed envelope.

### EC-3. `--frozen-network` HAR is corrupted or empty
On parse failure: hard-fail at run-start with a clear error. On empty HAR: every request misses; with default `--allow-network-miss=false`, every test fails as `infra_fail` and the run produces zero clusters. Acceptable — the failure is loud.

### EC-4. `--frozen-network` + `--allow-network-miss` + miss
Live request goes through, response is NOT appended to the HAR (replay HAR is read-only). Telemetry: `summary.json.networkReplay.missed += 1`. Determinism contract is voided for this run. CI test should not use this mode.

### EC-5. Two `--frozen-clock` runs on different machines
Same `bugs.jsonl` modulo machine-specific paths. We do NOT pin `process.cwd()` into emitted artifacts — verify (audit task §10). If a path leaks, normalize to a relative path before emit.

### EC-6. Recording a HAR while the target app's clock is wall-clock
The target app's responses include `Date.now()`-stamped fields (createdAt, etc.). These are baked into the HAR. Replay returns the same bytes. **Cross-machine replay is byte-identical because both replays read the same HAR** — they don't re-call the target. This is the correct behavior; the HAR is the snapshot.

### EC-7. Browser process-level non-determinism (compositor jitter)
Layout-shift score, INP, LCP can differ even with frozen clock + frozen network. These feed into perf detectors. Mitigation: when `clock.kind === 'frozen'`, perf detectors emit a *categorical* verdict (good/needs-improvement/poor per `web-vitals` thresholds) instead of the raw number. The categorical verdict is what enters the `clusterSignature`. Numbers stay in the artifact for inspection but are excluded from the canonical hash. New helper: `coarsenPerfForDeterminism(metrics, thresholds)`.

### EC-8. Concurrent test result interleaving
`uiQueue` and `apiQueue` drain concurrently (`Promise.all([drainQueue(ui), drainQueue(api)])`). Even with frozen network, micro-task scheduling can land results in different orders. Mitigation: cluster ordering is by `signatureKey`, not first-seen. Within-cluster occurrence ordering is by `occurrenceId` ASC. Both are seeded → fully deterministic.

### EC-9. cuid2 timing component
cuid2's `init()` uses `Date.now().toString(36)` internally. With a frozen clock at the cuid2 layer, ids would collide if counter+entropy don't dominate. Solution: pass a custom `random` (mulberry32) AND let cuid2 still use `Date.now()` internally — the per-call `time` is constant under frozen clock, but the seeded random+counter combination still produces unique-and-stable ids. Verify with a unit test (1000 calls, all unique, fully reproducible across two factory instances with same seed).

### EC-10. `--seed 0`
Permitted. mulberry32 with state 0 produces a valid stream after the first iteration (first call returns ~0.166). No special-case.

### EC-11. `--seed` overflow
Accept any 32-bit unsigned integer. Document the range. Reject negative/non-integer/non-numeric with a clear error.

### EC-12. HAR with redacted `Authorization` headers
Replay tolerates this — the response body is what the client cares about, not whether the request header in the HAR matches what we'd send. We do NOT use HAR request headers to validate the request; we use them only to match URL+method+body.

### EC-13. Determinism mode + `--resume`
A resumed run reads `runState` from disk, picking up partial clusters. Resume + determinism is incompatible — the partial state's id space already exists. Reject `--seed` together with `--resume` with a clear error: "seeded runs cannot resume; start a new run."

### EC-14. Determinism mode + concurrency > 1
Allowed. Concurrency affects *when* tests complete but not the cluster they map into (signature is deterministic). Within-cluster sort stabilizes order. Verify with a CI test at concurrency=4.

### EC-15. `--frozen-network` recording captures sensitive data
HARs may contain JWT tokens, session cookies, or PII in response bodies. Document that HARs MUST be treated like the underlying credentials. Add a `.bughunter-har-redact.json` config (future, not V32) to scrub specific JSON paths from response bodies.

### EC-16. Sub-millisecond cluster collision
Two detections produce the same `signatureKey` within the same cluster — they collapse into one cluster (correct). Two detections produce different `signatureKey`s but happen to sort adjacently — order is by signature, fully deterministic.

---

## 6. Acceptance criteria

### 6.1 Byte-identity test (the CI gate)

```bash
# Setup: seed-able fixture
SEED=1234
CLOCK="2026-05-01T12:00:00.000Z"
HAR=fixtures/v32-determinism/v32-fixture.har
PROJ=fixtures/v32-determinism/test-project

# Run twice
bughunter run --seed $SEED --frozen-clock $CLOCK --frozen-network $HAR --concurrency 4 $PROJ
HASH_A=$(sha256sum $PROJ/.bughunter/runs/*/bugs.jsonl | cut -d' ' -f1)
rm -rf $PROJ/.bughunter/runs/

bughunter run --seed $SEED --frozen-clock $CLOCK --frozen-network $HAR --concurrency 4 $PROJ
HASH_B=$(sha256sum $PROJ/.bughunter/runs/*/bugs.jsonl | cut -d' ' -f1)

[ "$HASH_A" = "$HASH_B" ] || { echo "FAIL: bugs.jsonl differs"; exit 1; }
echo "PASS: bugs.jsonl byte-identical ($HASH_A)"
```

This runs in CI on every PR. Failure blocks merge.

### 6.2 Cross-concurrency identity

Same SEED+CLOCK+HAR with `--concurrency 1` and `--concurrency 4` must produce the same `bugs.jsonl` SHA-256. Tests EC-8 / EC-14.

### 6.3 Canonical hash of `summary.json`

`summary.json` excluding the wall-clock-derived envelope (see §6.5) hashes identically across two runs.

### 6.4 Partial-determinism (`--seed` only)

`bughunter run --seed 1234 <proj>` twice produces:
- Same `bugs.jsonl` line count
- Same set of `clusterSignature` values (set equality, not byte equality)
- Same set of `kind` values

`summary.json.byKind` matches. Timestamps differ — that's expected.

### 6.5 Canonical hash recipe

The CI gate hashes `bugs.jsonl` as-is (every byte counts) AND a `summary-canonical.json` derived from `summary.json` by stripping:
- `actualRuntimeMs`, `projectedRuntimeMs`
- Any `durationMs` field at any depth
- `discovery.crawlTelemetry.elapsedMs` (if present)
- `vision.costUsd` (varies with token count which varies with HAR sample)
- `formReachabilityProbes.durationMs`

Implemented as a `canonicalize(obj, stripPaths)` utility in `lib/canonical.ts`. The strip-path list is a constant in the test, not a CLI flag — it's a property of the test, not the run.

### 6.6 Non-canonical-mode hash (negative test)

A run WITHOUT `--seed` MUST NOT produce a stable hash. Verify `bugs.jsonl` differs across two unseeded runs (sanity check that we didn't accidentally make wall-clock runs deterministic by other means).

### 6.7 Help text + error messages

- `bughunter run --help` lists the three new flags with one-line descriptions.
- `--seed abc` (non-numeric): "Error: --seed must be a 32-bit non-negative integer; got 'abc'"
- `--frozen-clock 2026-13-99` (invalid): "Error: --frozen-clock: invalid ISO 8601: '2026-13-99'"
- `--frozen-network missing.har`: "Error: --frozen-network: file not found: missing.har"
- `--seed 1234 --resume <runId>`: "Error: --seed cannot be combined with --resume"

### 6.8 Determinism telemetry in summary

`summary.json.deterministic = { seed, frozenClockIso, frozenNetworkPath, networkReplay: { matched, missed, unmatchedRecorded } }` when any of the three flags is set. Absent when none are set.

---

## 7. Negative requirements

- Do **not** add a `bughunter run --deterministic` shortcut that pre-fills all three flags. Each flag is independent; the user composes.
- Do **not** make any flag implicit. If `--frozen-network` is set without `--seed`, run with wall-clock RNG; do not auto-seed.
- Do **not** record HARs by default. Recording requires explicit `--record-network <path>`.
- Do **not** mutate the existing `RunOptions` shape in a breaking way. New fields are optional.
- Do **not** introduce a parallel id namespace (UUID v4, ksuid, ulid). Cuid2 with seeded init is the one path.
- Do **not** monkey-patch `Date` globally on the Node side. The existing CLI code uses `new Date()` literally; replace with `nowIso(clock)`. Globals would taint other tests.
- Do **not** sort `summary.json.byKind` keys differently from the rest of the document. The canonical-keys serializer applies uniformly.
- Do **not** silently drop unmatched HAR entries. Surface via `summary.json.networkReplay.unmatchedRecorded`; CI fails if non-zero in the canonical fixture.
- Do **not** introduce a runtime fetch dep to support replay. Use the existing `playwright-core` route fulfillment via the camofox `network_fault` MCP tool.

---

## 8. Files to touch

### New files (8 total)

| File | LOC | Purpose |
|---|---|---|
| `packages/cli/src/lib/rng.ts` | ~30 | mulberry32 + helpers |
| `packages/cli/src/lib/clock.ts` | ~50 | `Clock` discriminated union, `nowIso`, `nowMs`, `makeClock` |
| `packages/cli/src/lib/ids.ts` | ~50 | `setIdFactory`, `createId` re-export, seeded cuid2 init |
| `packages/cli/src/lib/canonical.ts` | ~80 | `canonicalStringify` (sorted keys, stable), `canonicalize(obj, stripPaths)` |
| `packages/cli/src/adapters/har-replay.ts` | ~150 | HAR parser + matcher, `--record-network` writer extension, `--frozen-network` replay |
| `packages/cli/src/lib/clock.test.ts` | ~80 | unit tests for `makeClock`, `nowIso`, frozen invariance |
| `packages/cli/src/lib/ids.test.ts` | ~60 | unit tests: same seed → same id sequence (1000 calls) |
| `packages/cli/src/adapters/har-replay.test.ts` | ~120 | unit tests for match, miss, redact, normalize |

### Modified files (15 total)

| File | Change | Risk |
|---|---|---|
| `packages/cli/src/cli/main.ts` | Parse 3 new flags + 2 helpers (`--record-network`, `--allow-network-miss`); validate; forward to `RunOptions` | low |
| `packages/cli/src/cli/run.ts` | Construct `Clock` + `IdFactory` + `HarReplayer`; install singletons; thread `clock` into phases that emit timestamps; replace `createId()` import; add `--seed` + `--resume` mutex | medium |
| `packages/cli/src/store/run-state.ts` | `startedAt` uses `nowIso(clock)` | low |
| `packages/cli/src/phases/cluster.ts` | `firstSeenAt`/`lastSeenAt` use `nowIso(clock)`; sort clusters by `signatureKey`; sort within-cluster occurrences by `occurrenceId`; replace `createId` import | medium |
| `packages/cli/src/phases/emit.ts` | Use `canonicalStringify` for `bugs.jsonl` and `summary.json`; emit `summary.deterministic` block | medium |
| `packages/cli/src/phases/execute.ts` | All 9 `new Date().toISOString()` sites + `createId` import; per-test deadlines stay on wall-clock | medium |
| `packages/cli/src/phases/cross-user.ts` | `nowIso(clock)` + `createId` import | low |
| `packages/cli/src/phases/race-runner.ts` | `nowIso(clock)` + `createId` import + raceNonce via factory | low |
| `packages/cli/src/phases/auth-flow.ts` | Replace 2 `Math.random()` calls with `seededRng()` from RNG context; `createId` import | low |
| `packages/cli/src/mutation/apply.ts` | `createId` import (5 sites) | low |
| `packages/cli/src/mutation/palette.ts` | `dateCases()` accepts a `clock` param; threads from `formTestCases` / `apiTestCases` | medium (signature change in the palette layer) |
| `packages/cli/src/store/filesystem.ts` | Sort `fs.readdirSync` result | low |
| `packages/cli/src/phases/analyze.ts` | Sort `fs.readdirSync` result | low |
| `packages/cli/src/static/bundle-analyzer.ts` | Sort `fs.readdirSync` result | low |
| `packages/cli/src/adapters/browser-mcp.ts` | After `navigate`, install V23 frozen-clock polyfill via `evaluate(installFrozenClock(clock.isoTime))`; install HAR replay handler at adapter construction when in replay mode | high — this is the most invasive change |

### CI test files

| File | Purpose |
|---|---|
| `tests/v32-determinism/byte-identity.test.ts` | The §6.1 gate: run twice, compare hashes. Uses the new fixture. |
| `tests/v32-determinism/cross-concurrency.test.ts` | §6.2: concurrency 1 vs 4. |
| `tests/v32-determinism/partial-seed.test.ts` | §6.4: structural identity without frozen-clock. |
| `tests/v32-determinism/error-messages.test.ts` | §6.7: bad inputs produce the specified messages. |

### Fixture

| Path | Contents |
|---|---|
| `fixtures/v32-determinism/test-project/.bughuntrc.json` | Minimal config |
| `fixtures/v32-determinism/test-project/index.html` | Static page with deliberate bugs (~3 detectors hit: missing alt, broken contrast, console error on click) |
| `fixtures/v32-determinism/v32-fixture.har` | Recorded HAR for the static page (small) |
| `fixtures/v32-determinism/v32-fixture.har.normalize.json` | Empty (no normalization needed for a static fixture) |

The fixture is intentionally tiny so the CI test runs in <30s.

---

## 9. Task breakdown

| # | Task | Files | Deps | Effort |
|---|---|---|---|---|
| 1 | Add `mulberry32` PRNG + tests | `lib/rng.ts`, `lib/rng.test.ts` | none | 30 min |
| 2 | Add `Clock` + `nowIso`/`nowMs` + tests | `lib/clock.ts`, `lib/clock.test.ts` | none | 30 min |
| 3 | Add `setIdFactory`/`createId` seam + tests | `lib/ids.ts`, `lib/ids.test.ts` | 1 | 30 min |
| 4 | Add `canonicalStringify` + `canonicalize` + tests | `lib/canonical.ts`, plus a small test | none | 45 min |
| 5 | Wire 3 flags through `main.ts` + `run.ts` (no new behavior) | `cli/main.ts`, `cli/run.ts` | 1-3 | 45 min |
| 6 | Replace 8 `import { createId } from '@paralleldrive/cuid2'` with seam | 8 files (search-replace) | 3 | 30 min |
| 7 | Replace 13 `new Date().toISOString()` sites with `nowIso(clock)` (in-scope sites only — see §4) | 7 files | 2, 5 | 1 hour |
| 8 | Replace 2 `Math.random()` in `auth-flow.ts` with seeded rng | `phases/auth-flow.ts` | 1, 5 | 15 min |
| 9 | Sort `fs.readdirSync` in 3 sites | 3 files | none | 15 min |
| 10 | Sort clusters by `signatureKey` and within-cluster occurrences by `occurrenceId` before emit | `phases/cluster.ts`, `phases/emit.ts` | 4 | 30 min |
| 11 | Use `canonicalStringify` for `bugs.jsonl` and `summary.json` | `phases/emit.ts`, `store/filesystem.ts` (`appendJsonl`, `writeJsonFile`) | 4 | 45 min |
| 12 | Date palette `happy` variant uses frozen clock | `mutation/palette.ts`, `mutation/apply.ts` | 2 | 30 min |
| 13 | HAR replay adapter (parser + matcher + miss handling) | `adapters/har-replay.ts`, tests | none | 2 hours |
| 14 | Wire HAR replay through camofox adapter via `network_fault` MCP tool | `adapters/browser-mcp.ts` | 13, V20 | 2 hours |
| 15 | Wire HAR replay through vision client (injected fetch) | `adapters/vision-client.ts`, `cli/run.ts` | 13 | 1 hour |
| 16 | Install V23 frozen-clock polyfill after every navigate | `adapters/browser-mcp.ts` | 2, V23 | 1 hour |
| 17 | Reject `--seed` with `--resume` | `cli/run.ts` | 5 | 10 min |
| 18 | Emit `summary.deterministic` telemetry block | `phases/emit.ts` | 5, 13 | 20 min |
| 19 | Build the V32 test-project + HAR fixture | `fixtures/v32-determinism/*` | 13, 14 | 1 hour |
| 20 | Write the 4 CI tests | `tests/v32-determinism/*.test.ts` | 1-19 | 2 hours |
| 21 | Update `bughunter run --help` text | `cli/main.ts` (USAGE constant) | 5 | 15 min |
| 22 | Audit `summary.json` for path/pid/host leaks; normalize | `phases/emit.ts` | 4 | 30 min |

**Total:** ~17 hours of focused agent work, fits comfortably in Phase C's 2-3 week budget.

**Critical path:** 13 → 14 → 19 → 20 (HAR plumbing). Tasks 1-12 are parallelizable across multiple agents.

---

## 10. Definition of Done

| Criterion | Verifier |
|---|---|
| All new unit tests pass | `npm test` in `packages/cli` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Byte-identity CI test passes (§6.1) | `npm test -- v32-determinism/byte-identity` |
| Cross-concurrency CI test passes (§6.2) | `npm test -- v32-determinism/cross-concurrency` |
| Partial-seed CI test passes (§6.4) | `npm test -- v32-determinism/partial-seed` |
| Error-message CI test passes (§6.7) | `npm test -- v32-determinism/error-messages` |
| `bughunter run --help` lists `--seed`, `--frozen-clock`, `--frozen-network`, `--record-network`, `--allow-network-miss` | manual `bughunter run --help` |
| Existing test suite (~all V05–V22 tests) passes unchanged | `npm test` |
| `summary.json.deterministic` block present when any flag set, absent otherwise | unit + integration test |
| Negative test: unseeded run produces non-identical hashes (§6.6) | CI test |
| Smoke run on Aspectv3 with all three flags produces a stable hash across two consecutive runs | manual runbook |

---

## 11. Open questions

1. **V23 dependency timing.** V23 (frozen-clock browser polyfill) hasn't shipped on `main` yet. Two options: (a) V32's coder ships the CLI side (everything except §3.2's browser-side install) and stubs `installFrozenClock` to a no-op until V23 lands; (b) block V32 on V23 finishing first. **Recommendation: (a).** The CLI side is independently valuable — `summary.json` and most of `bugs.jsonl` get their timestamps from the Node side, not the browser. Browser-side timestamps (axe-core's internal Date use, web-vitals) are a smaller fraction. Ship CLI-side; finish browser-side after V23.

2. **HAR replay normalization scope.** The `[harPath].normalize.json` sibling file (§3.3) lets users strip query parameters from the match key (cache busters, `?_t=<timestamp>`). For V32's CI fixture the static page has no such concerns and we don't need normalization. For Aspectv3's smoke test, the API likely emits Cloudflare cache-bust query params. **Should V32 ship the normalization config or defer to V33?** Recommendation: ship a minimal version (just `stripQueryParams: string[]`) — the canonical Aspectv3 example needs it.

3. **Vision API redaction policy.** `Authorization: Bearer sk-ant-...` MUST be redacted in HARs. Should we also redact (a) request body prompts (PII), (b) response body completions (PII), (c) anthropic-organization-id headers (org-identifying)? Recommendation: redact only `Authorization` and `anthropic-organization-id` for V32; document that recorded prompts/completions are at the user's discretion. Future spec for full PII redaction.

4. **`--frozen-network` for the target app's *server* (not just camofox-side requests).** If the target is a Node app and BugHunter spawns it, the target also makes outbound calls (to its DB, to third-party APIs). Those aren't intercepted by camofox. Recommendation: out of scope. Document. Users wanting full server-side determinism use a fixed-snapshot DB and mock third-party APIs at the target's boundary, not BugHunter's.

5. **Should `bughunter run` emit a warning when only some of the three flags are set?** E.g. `--seed` without `--frozen-clock` — should the CLI warn that timestamps will differ? Recommendation: yes, one-line warning to stderr. Helps users understand they're in partial-determinism mode.

6. **`runId` determinism.** Today, `runId = createId()`. Under `--seed`, `runId` is also seeded → two runs with the same seed produce the same `runId`. This means the second run's `.bughunter/runs/<runId>/` is the same path as the first → silently overwrites or collides. Recommendation: under `--seed`, prefix runId with the seed: `det-<seed>-<seeded-cuid>`. This avoids collisions while keeping the seed visible in artifact paths. Alternative: append a wall-clock suffix (breaks pure determinism for the path, fine for the bytes).

7. **Cluster `id` (line 81) vs `signatureKey` (line 95).** Both are stable per-cluster. Today, `id` is what downstream code (replay, retest) uses. Under `--seed`, `id` is deterministic-but-opaque. **Should V32 introduce a `bugIdentity` field tied to `(projectName, signatureKey)` per §7.1 of the path-to-exhaustive spec?** Recommendation: defer to V33 (cross-time). V32 establishes the determinism foundation; V33 defines stable cross-run identity on top.

8. **`--frozen-network` interplay with race-condition variants (V19).** The race runner (`phases/race-runner.ts`) deliberately interleaves N concurrent requests to provoke server-side races. HAR replay returns the *recorded* response — there's no "race" to provoke. Race detectors will not find races in replay mode. Recommendation: when `--frozen-network` AND `raceConditions.enabled`, log a warning and skip the race-runner phase. Determinism mode is for regression testing, not race-detection runs.

9. **What happens when `--frozen-network` is set but a request is to `localhost:3107` (SurfaceMCP)?** Today SurfaceMCP is a sibling local process, not part of the target. Recommendation: capture SurfaceMCP requests in the HAR too — they're as deterministic-relevant as any other network call. SurfaceMCP itself stays live during recording; replay covers it.

10. **Should the CI test fail-on-warn for unmatched-recorded HAR entries?** If the HAR has 50 entries and only 47 match during replay, the unmatched 3 are dead weight. CI should flag them. Recommendation: CI test asserts `unmatchedRecorded === 0` for the canonical fixture; allows non-zero in user-supplied HARs but emits a warning.

---

## 12. Risks + escape hatches

- **Risk: cuid2 internal use of `Date.now()` causes collisions under frozen wall-clock.** Mitigation: §EC-9. Verify with a 1000-call uniqueness test in `lib/ids.test.ts`.
- **Risk: `network_fault` MCP tool lacks the matching semantics we need.** V20 added `network_fault(url, body)` — verify it accepts a regex/method/body matcher and not just URL prefix. If it doesn't, V32's coder files a V20-amendment PR before completing task #14. **Pre-implementation check required.**
- **Risk: V8 / Node version drift causes `JSON.stringify` ordering changes.** Mitigation: `canonicalStringify` does its own recursive key-sort; doesn't rely on V8 default behavior.
- **Risk: changing the cluster sort order breaks downstream consumers (replay, retest CLI commands, bughunter-mcp tools).** They use `clusterId` and `occurrenceId` as keys, not `bugs.jsonl` line offsets. Verify via the existing test suite — if any test asserts a specific cluster ordering in `bugs.jsonl`, surface it before merge.
- **Escape hatch: `--no-canonical-jsonl`** — emergency flag to revert to insertion-order JSONL while keeping the rest of determinism. NOT in scope for V32 unless a regression surfaces.

---

## 13. Killer-demo runbook (Aspectv3)

```bash
# 1. Record a HAR
cd /root/Aspectv3
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --seed 1234 --frozen-clock 2026-05-01T12:00:00.000Z \
  --record-network /root/Aspectv3/.bughunter/aspectv3.har \
  --max-bugs 50 --budget 600000 --a11y --seo

# 2. Hash bugs.jsonl
RUN1=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
HASH_1=$(sha256sum /root/Aspectv3/.bughunter/runs/$RUN1/bugs.jsonl | cut -d' ' -f1)
echo "Run 1 hash: $HASH_1"

# 3. Replay
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --seed 1234 --frozen-clock 2026-05-01T12:00:00.000Z \
  --frozen-network /root/Aspectv3/.bughunter/aspectv3.har \
  --max-bugs 50 --budget 600000 --a11y --seo

# 4. Hash again
RUN2=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
HASH_2=$(sha256sum /root/Aspectv3/.bughunter/runs/$RUN2/bugs.jsonl | cut -d' ' -f1)
echo "Run 2 hash: $HASH_2"

# 5. Verify
[ "$HASH_1" = "$HASH_2" ] && echo "DETERMINISTIC ✓" || echo "FAIL: hash drift"

# 6. Verify network replay coverage
jq '.deterministic.networkReplay' /root/Aspectv3/.bughunter/runs/$RUN2/summary.json
# Expect: { matched: N, missed: 0, unmatchedRecorded: 0 }
```

Expected: HASH_1 == HASH_2; `networkReplay.missed === 0`; `networkReplay.unmatchedRecorded === 0`.
