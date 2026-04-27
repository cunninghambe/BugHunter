# SPEC: Action Log Persistence — Ensure `fullArtifacts` Files Exist On Disk

## 1. Problem

When `/bughunt fix` performs a post-fix retest, it reads the cluster occurrence
records from `.bughunter/runs/<runId>/bugs.jsonl`, then for each occurrence
with `fullArtifacts: true` it calls
`readActionLog(actionLogsDir, occ.occurrenceId)`
(`packages/cli/src/ops/retest.ts:107`).
The action log path recorded in the cluster (`actionLogPath`) does not exist
on disk, so retest aborts the occurrence with
`details[].error = "Action log not found: <path>"`, which collapses to
`verdict: 'not_fixed'` even when the underlying bug has been fixed.

Concrete ground-truth example — Spoonworks run
`i8vbryubrwice5hoi1mc2eph` (`/root/spoonworks/.bughunter/runs/i8vbryubrwice5hoi1mc2eph/`):

- Cluster `vnavmbuj933ze1uljy8b7mc9` (`missing_state_change`, "Open cart"
  button) records `actionLogPath:
  ".../action-logs/o5pi3fomg01le5nsixrjqtjh.json"` with `fullArtifacts: true`.
  File does not exist.
- Cluster `kzwxks74la85m4owk1x8bo5c` (`missing_state_change`,
  `button:nth-of-type(1)`) records `actionLogPath:
  ".../action-logs/xuk55ur1rhyycs89htmtgmer.json"` with `fullArtifacts: true`.
  File does not exist.
- The same is true for **every** occurrenceId that appears in `bugs.jsonl`
  for this run. Verified by sampling 10 occurrence ids from the JSONL and
  checking the filesystem: 10/10 missing.
- The `action-logs/` directory contains 600 files (one per executed UI/API
  test that completed normally). None of those filenames match any
  occurrenceId recorded in any cluster.
- The `screenshots/`, `dom/`, `console/`, and `network/` directories are
  completely empty — they are created by `ensureRunDirs`
  (`packages/cli/src/store/filesystem.ts:37`) but no code ever writes into
  them.

The retest path (`bughunter replay <occurrenceId>` and the `/bughunt fix`
verifier in `ops/retest.ts`) is therefore non-functional for the
overwhelming majority of clusters.

## 2. Investigation Findings

The existing code has two independent defects, both of which contribute.

### Finding A — The `occurrenceId` written by the executor is a different cuid from the `occurrenceId` recorded in the cluster

`packages/cli/src/phases/execute.ts:160`

```ts
async function executeUiTest(...) {
  const start = Date.now();
  const occurrenceId = createId();              // (1) executor's id
  ...
  const actionLog = { occurrenceId, ... };
  ...
  writeActionLog(actionLogsDir, actionLog);    // file is named (1)
  return { testId: tc.id, passed, bugs, ... }; // occurrenceId NOT returned
}
```

`packages/cli/src/phases/execute.ts:342` — `executeApiTest` does the same
thing: mints `const occurrenceId = createId();` (line 342), writes the action
log (line 408), and returns a `TestResult` that contains `testId` but no
`occurrenceId`.

The `TestResult` shape (`packages/cli/src/types.ts:268-278`) has no field
for `occurrenceId`:

```ts
export type TestResult = {
  testId: string;
  passed: boolean;
  bugs: BugDetection[];
  infrastructureFailure?: InfrastructureFailure;
  durationMs: number;
  preState?: PreState;
  postState?: PostState;
};
```

`packages/cli/src/phases/cluster.ts:66` then mints a **brand-new** cuid for
each detection's occurrence:

```ts
for (const { testId, detection } of detections) {
  ...
  const cluster = clusterMap.get(sig)!;
  const occId = createId();                    // (2) cluster's id
  const summaryOcc: OccurrenceSummary = {
    occurrenceId: occId,
    testId,
    ...
  };
  cluster.occurrences.push(summaryOcc);
}
```

When `upgradeToFull` (`cluster.ts:128-132`) emits the path, it uses the
cluster id (2):

```ts
actionLogPath: `${actionLogsDir}/${occ.occurrenceId}.json`,
```

So the cluster records `<cluster-id>.json` while the writer wrote
`<executor-id>.json`. They never match. Every `fullArtifacts: true`
occurrence's `actionLogPath` points to a non-existent file — including the
600 occurrences that were correctly written under their executor-side ids.

### Finding B — UI executor skips the action-log write on the rethrown error path

`packages/cli/src/phases/execute.ts:221-261`. When a `BrowserMcpError` is
**not** `element_not_found`, `transport`, or `timeout`, the code rethrows:

```ts
} catch (err) {
  if (err instanceof BrowserMcpError && err.kind === 'element_not_found') {
    writeActionLog(actionLogsDir, actionLog);   // <-- writes
    return { ... infrastructureFailure ... };
  }
  if (err instanceof BrowserMcpError && (err.kind === 'transport' || err.kind === 'timeout')) {
    writeActionLog(actionLogsDir, actionLog);   // <-- writes
    return { ... infrastructureFailure ... };
  }
  throw new Error(`Browser action failed: ${String(err)}`);  // (line 260) NO write
}
```

The outer catch (`execute.ts:311-330`) handles the rethrow and returns an
infrastructure failure but never calls `writeActionLog`. Same for
`withTab` itself failing (open/close-tab errors). This is consistent with
the observation that this run produced 602 ran tests but only 600 action
logs (601 if we treat `executeApiTest` as always writing — see next note);
the 1–2 missing files are tests that hit this path. The retest cannot
replay them.

`executeApiTest` only writes the action log if it reaches line 408. There
is no `try/finally` around the surface call (`execute.ts:348`), so a thrown
error from `surface_call` never produces an action log either.

### Finding C — Screenshot, DOM, console, network artifacts are never written anywhere

Grep confirms: nothing in `packages/cli/src/**` ever writes into
`screenshotsDir`, `domDir`, `consoleDir`, or `networkDir`. The `cluster.ts`
phase emits paths to these directories, but the directories are created
empty by `ensureRunDirs` and remain empty. SPEC.md § 3.7 line 275 lists all
five artifact kinds as required for full-artifact occurrences; only the
JSON action log has a writer at all.

### Finding D — `bugs.jsonl` records absolute paths but SPEC.md shows relative

`cluster.ts:128` interpolates `actionLogsDir` directly into the path. Because
`runPaths` joins to `projectDir` which the run command receives as an
absolute path (`packages/cli/src/cli/run.ts`), the emitted paths in
`bugs.jsonl` are absolute (e.g.
`/root/spoonworks/.bughunter/runs/<runId>/action-logs/<id>.json`), while
SPEC.md § 3.6 sample shows relative
(`.bughunter/runs/<runId>/screenshots/occ-cuid.png`). This is a separate
cosmetic mismatch from the documented surface; flag but do not fix in this
spec — fixing here would silently change the public JSONL contract. Out of
scope.

## 3. Root Cause

Failure modes (a) **filename mismatch between writer and consumer** and
(b) **conditional writes that should be unconditional for occurrences
that may end up with `fullArtifacts: true`** are both present, plus
(d) **screenshot/dom/console/network capture is not implemented at all**.

The single canonical fix for (a) is: **the executor must mint the
occurrenceId, write artifacts under that id, and return the id in
`TestResult` so the cluster phase reuses it instead of minting a new one.**

The fix for (b) is: **wrap the executor's body in `try/finally` so
`writeActionLog` runs on every code path including rethrown errors.**

The fix for (d) is: **inside the executor, after the action runs (or after
it throws), capture and persist the four extra artifacts to
`<artifactDir>/<occurrenceId>.<ext>` before returning.** Because (a) is
fixed, the cluster phase will record paths that match what the executor
wrote.

Failure mode (c) (artifact-budget pruning before path recording) is **not
the cause**. `applyArtifactBudget` is called separately and only flips
`fullArtifacts: true` to `false` — it does not delete files or change
paths.

## 4. Fix Design

Three coordinated changes. All fit in `packages/cli/src/`. Numbered for
explicit ordering inside a single PR.

### 4.1 Add `occurrenceId` to `TestResult` and propagate it from executor to cluster

**File:** `packages/cli/src/types.ts` — append to `TestResult` (after
line 277):

```ts
export type TestResult = {
  testId: string;
  /**
   * Stable id minted by the executor at test start. Used as the filename
   * for action-log + screenshot + DOM + console + network artifacts:
   *   action-logs/<occurrenceId>.json
   *   screenshots/<occurrenceId>.png
   *   dom/<occurrenceId>.html
   *   console/<occurrenceId>.log
   *   network/<occurrenceId>.har
   * The cluster phase reuses this id when materializing OccurrenceFull,
   * so that the recorded artifact paths point to files that exist.
   * Always set; never undefined.
   */
  occurrenceId: string;
  passed: boolean;
  bugs: BugDetection[];
  infrastructureFailure?: InfrastructureFailure;
  durationMs: number;
  preState?: PreState;
  postState?: PostState;
};
```

**File:** `packages/cli/src/phases/execute.ts`

- `executeUiTest` (line 150): keep `const occurrenceId = createId();` at
  line 160. Add `occurrenceId` to **every** return object (5 sites: lines
  223-239, 243-259, 302-309, plus the outer catch at 322-329, plus any
  added by 4.2).
- Same for `executeApiTest` (line 333): the `occurrenceId` at line 342 must
  now appear in the early-return at line 345 and the final return at
  line 410.
- `runTest` (line 79) — the synthetic infra-failure return at line 97-103
  must mint an id (`createId()`) so that downstream code never sees
  `undefined`. Use a separate variable; the inner test never reached the
  point of minting one.

**File:** `packages/cli/src/phases/cluster.ts`

- Replace line 66 `const occId = createId();` with a lookup against the
  `TestResult` for this `testId`. The cluster phase currently does not
  receive results — only `detections: Array<{ testId; detection }>`. Add a
  new option to `ClusterOptions` (line 9):

  ```ts
  export type ClusterOptions = {
    detections: Array<{ testId: string; detection: BugDetection }>;
    testCases: TestCase[];
    runId: string;
    projectDir: string;
    actionLogsDir: string;
    screenshotsDir: string;
    domDir: string;
    consoleDir: string;
    networkDir: string;
    maxClusters: number;
    /**
     * Map from testId → occurrenceId minted by the executor. The cluster
     * phase reuses these ids when forming OccurrenceSummary so that
     * recorded artifact paths match the files written during execute.
     * Required: every detection's testId must be present.
     */
    occurrenceIdByTestId: Map<string, string>;
    stateByTestId?: Map<string, { preState: PreState; postState: PostState }>;
  };
  ```

- In the `for` loop at line 36, replace `const occId = createId();` with:

  ```ts
  const occId = opts.occurrenceIdByTestId.get(testId);
  if (!occId) {
    throw new Error(
      `cluster: missing occurrenceId for testId ${testId}; ` +
      `executor must populate occurrenceIdByTestId for every TestResult`,
    );
  }
  ```

  The hard error is intentional. Silent fallback re-introduces the bug.

- **Edge case — same `testId` produces multiple detections.** A single
  test can yield more than one bug (e.g. a console error AND a network 5xx
  in the same run). The current code mints one cuid per detection, so each
  detection currently appears as a distinct occurrence. Under the new
  contract we must keep that behavior **but** still resolve to a single
  set of artifact files (one screenshot per test, not one per bug). The
  resolution: all detections from the same `testId` share the same
  `occurrenceId` and therefore the same `actionLogPath` etc. This is
  correct — the artifacts capture the test, not the bug. Document this
  inline at the call site.

**File:** `packages/cli/src/cli/run.ts` — at the existing
`runCluster({ ... })` call site (line 160), build the map from
`results`:

```ts
const occurrenceIdByTestId = new Map<string, string>(
  results.map(r => [r.testId, r.occurrenceId]),
);
const { clusters } = runCluster({
  ...
  occurrenceIdByTestId,
  stateByTestId,
});
```

### 4.2 Make `writeActionLog` unconditional in the executor (try/finally)

**File:** `packages/cli/src/phases/execute.ts` — refactor `executeUiTest`
to a single try/finally pattern:

```ts
async function executeUiTest(...): Promise<TestResult> {
  const start = Date.now();
  const occurrenceId = createId();
  const actionLog = { occurrenceId, runId, role, page, baseUrl, actions: [...], createdAt };
  let result: TestResult;
  try {
    result = await browser.withTab(pageUrl, headers, async (scope) => {
      ...
      // existing body, but every return statement now includes occurrenceId
    });
  } catch (err) {
    result = {
      testId: tc.id,
      occurrenceId,
      passed: false,
      bugs: [],
      infrastructureFailure: { ... },
      durationMs: Date.now() - start,
    };
  } finally {
    // Write action log on every code path. Writing is cheap (single fs.writeFileSync).
    try {
      writeActionLog(actionLogsDir, actionLog);
    } catch (writeErr) {
      log.warn('writeActionLog failed', { occurrenceId, err: String(writeErr) });
    }
  }
  return result!;
}
```

Remove the two early `writeActionLog(...)` calls inside the inner catch
(lines 223, 242, 300) — they are now subsumed by the `finally`. Removing
them avoids a double-write.

Apply the same `try/finally` shape to `executeApiTest`. The action-log
object can be built up-front (the `inputSchemaHash` field can be computed
without waiting for the surface call result).

### 4.3 Capture screenshot, DOM, console, network artifacts to disk

**File:** `packages/cli/src/phases/execute.ts` — inside `executeUiTest`'s
`browser.withTab` callback, after the action runs (after line 274 `const
postSnapshot = ...`) and before the inner return at line 302, persist:

```ts
import * as fs from 'node:fs';
import * as path from 'node:path';

// Screenshot — best effort; do not fail the test if it errors
await scope
  .screenshot(path.join(screenshotsDir, `${occurrenceId}.png`))
  .catch(err => log.warn('screenshot failed', { occurrenceId, err: String(err) }));

// DOM snapshot — write the post-action snapshot string we already captured
if (postSnapshot?.snapshot) {
  fs.writeFileSync(
    path.join(domDir, `${occurrenceId}.html`),
    postSnapshot.snapshot,
  );
}

// Console log — write the postConsoleErrors array as JSONL
if (postConsoleErrors.length > 0) {
  const lines = postConsoleErrors
    .map(e => JSON.stringify({ level: e.level, text: e.text, stack: e.stack }))
    .join('\n');
  fs.writeFileSync(path.join(consoleDir, `${occurrenceId}.log`), lines + '\n');
} else {
  // Empty marker so the path exists; retest can detect "no console errors"
  fs.writeFileSync(path.join(consoleDir, `${occurrenceId}.log`), '');
}

// Network HAR — v0.1: write a stub HAR ({ "log": { "entries": [] } }).
// Real HAR capture requires camofox-mcp v0.2 (see Risk § 7); for now we
// emit a valid empty HAR so retest's existence check passes and downstream
// consumers can `JSON.parse` without error.
fs.writeFileSync(
  path.join(networkDir, `${occurrenceId}.har`),
  JSON.stringify({
    log: { version: '1.2', creator: { name: 'bughunter', version: '0.1' }, entries: [] },
  }),
);
```

`executeUiTest` must accept the four new directories as parameters.
Update its signature (line 150) to take them, and pass them from
`runExecute` (line 83). To avoid an explosion of parameters, gather all
five into a single `paths: { actionLogsDir, screenshotsDir, domDir,
consoleDir, networkDir }` object derived from `runPaths`. The
`runExecute` already calls `runPaths(runState.projectDir, runState.runId)`
at line 52 — pass the resulting `paths` straight through to
`executeUiTest` and `executeApiTest`.

For `executeApiTest`, only the action log is meaningful; do not synthesize
fake screenshot / DOM / console / network files. SPEC § 3.7 lists all
five but the API path has no DOM and no screenshot. Document inline that
API occurrences emit only the action log; the cluster phase still records
the four extra paths but the retest must tolerate their absence.

**Cross-cutting:** the cluster phase's `upgradeToFull` (`cluster.ts:128-131`)
currently records all five paths unconditionally. With API occurrences
intentionally lacking four of them, retest will currently fail when it
tries to `readActionLog`. It does not currently read the screenshot/DOM/
console/network files, so the path mismatch only matters for tools
(humans, future code) that try to open them. Acceptable for v0.1.

## 5. Test Plan

### 5.1 New unit test: `packages/cli/tests/action-log-roundtrip.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeActionLog, readActionLog } from '../src/repro/action-log.js';
import type { ActionLog } from '../src/repro/action-log.js';

describe('action-log persistence', () => {
  it('writes a file at the same path that bugs.jsonl will record', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bh-act-'));
    const log: ActionLog = {
      occurrenceId: 'occ-test-1',
      runId: 'run-1',
      role: 'owner',
      page: '/products',
      baseUrl: 'http://localhost:3000/products',
      actions: [{
        step: 0,
        kind: 'click',
        selector: 'button',
        url: 'http://localhost:3000/products',
        timestamp: '2026-01-01T00:00:00.000Z',
      }],
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const writtenPath = writeActionLog(dir, log);
    // The cluster phase records this exact path shape.
    expect(writtenPath).toBe(path.join(dir, 'occ-test-1.json'));
    expect(fs.existsSync(writtenPath)).toBe(true);
    const round = readActionLog(dir, 'occ-test-1');
    expect(round).toEqual(log);
  });
});
```

### 5.2 Cluster-phase test: `packages/cli/tests/cluster.test.ts` (extend)

Add a case verifying that `occurrenceIdByTestId` is honored:

```ts
it('reuses executor-minted occurrenceId from occurrenceIdByTestId', () => {
  const detections = [{ testId: 't1', detection: SOME_BUG }];
  const result = runCluster({
    detections,
    testCases: [TEST_CASE_T1],
    runId: 'r1',
    projectDir: '/tmp',
    actionLogsDir: '/tmp/al',
    screenshotsDir: '/tmp/s',
    domDir: '/tmp/d',
    consoleDir: '/tmp/c',
    networkDir: '/tmp/n',
    maxClusters: 100,
    occurrenceIdByTestId: new Map([['t1', 'exec-occ-1']]),
  });
  expect(result.clusters[0].occurrences[0].occurrenceId).toBe('exec-occ-1');
});

it('throws when occurrenceIdByTestId is missing an entry', () => {
  expect(() => runCluster({ ...minimal, occurrenceIdByTestId: new Map() }))
    .toThrow(/missing occurrenceId for testId/);
});
```

### 5.3 Integration check (manual, scripted)

After a fresh run on Spoonworks (or e2e harness):

```bash
cd /root/spoonworks
bughunter run --max-bugs 50
RUN_ID=$(jq -r .runId .bughunter/runs/*/state.json | tail -1)
node -e "
  const fs = require('fs');
  const path = require('path');
  const root = path.join('.bughunter/runs', '$RUN_ID');
  const lines = fs.readFileSync(path.join(root, 'bugs.jsonl'), 'utf-8')
    .trim().split('\n');
  let missing = 0, total = 0;
  for (const line of lines) {
    const cluster = JSON.parse(line);
    for (const occ of cluster.occurrences) {
      if (!occ.fullArtifacts) continue;
      total++;
      if (!fs.existsSync(occ.actionLogPath)) {
        console.error('MISSING action-log:', occ.occurrenceId);
        missing++;
      }
    }
  }
  console.log('checked', total, 'fullArtifacts occurrences;', missing, 'missing');
  process.exit(missing === 0 ? 0 : 1);
"
```

The script must exit 0. Promote it into
`packages/cli/tests/e2e/full-artifacts-on-disk.test.ts` once the e2e
harness already covers a real bug-producing run (see
`packages/cli/tests/e2e/`).

### 5.4 Existing tests that must continue to pass

- `packages/cli/tests/cluster.test.ts` — must be updated to pass
  `occurrenceIdByTestId` in every test case.
- `packages/cli/tests/cluster-phase.test.ts` — same.
- `packages/cli/tests/cluster-related.test.ts` — same.
- `packages/cli/tests/replay.test.ts` — unchanged; tests `replayActionLog`
  directly with an in-memory `ActionLog`.
- `packages/cli/tests/auto-fix-verify.test.ts` — likely needs new fixture
  data; check it does not assert on the executor occurrenceId being
  generated inside cluster.

## 6. Files to Touch

| File | Change |
|------|--------|
| `packages/cli/src/types.ts` | Add `occurrenceId: string` to `TestResult` |
| `packages/cli/src/phases/execute.ts` | Refactor both executors to `try/finally`; mint occurrenceId once; return it on every path; capture screenshot/DOM/console/network artifacts; accept `paths` param |
| `packages/cli/src/phases/cluster.ts` | Add `occurrenceIdByTestId` to `ClusterOptions`; replace `createId()` with map lookup; throw on missing entry |
| `packages/cli/src/cli/run.ts` | Build `occurrenceIdByTestId` from `results` and pass to `runCluster` |
| `packages/cli/tests/action-log-roundtrip.test.ts` | New unit test (5.1) |
| `packages/cli/tests/cluster.test.ts` | Add cases (5.2); update existing cases to pass `occurrenceIdByTestId` |
| `packages/cli/tests/cluster-phase.test.ts` | Update existing cases to pass `occurrenceIdByTestId` |
| `packages/cli/tests/cluster-related.test.ts` | Update existing cases to pass `occurrenceIdByTestId` |

No new top-level files. No changes to `repro/action-log.ts` (the writer
is correct as-is — the bug was in the caller). No changes to
`store/filesystem.ts` (paths are already correct). No changes to
`adapters/browser-mcp.ts` (the `screenshot()` method is already there).

## 7. Risk

### 7.1 In-flight runs (backward compat)

Existing `bugs.jsonl` files from prior runs have `actionLogPath` and
`occurrenceId` pairs that don't match files on disk. Those runs are
**already broken** under the current code; the fix does not regress them
further but also does not retroactively fix them. The retest path on old
runs will continue to fail with `Action log not found`. Acceptable: the
`/bughunt fix` workflow is supposed to operate on the most recent run
only.

`replay.ts` reads action logs by occurrenceId; old IDs in old `bugs.jsonl`
still won't resolve. Document in the PR: "old runs cannot be replayed;
`bughunter prune-runs` recommended after deploy."

### 7.2 Filename change

We are not changing the filename convention (`<occurrenceId>.json`). We
are changing **which** occurrenceId gets used. The convention itself is
preserved.

### 7.3 Screenshot capture failure modes

`scope.screenshot(path)` on camofox-mcp can fail (process exit, invalid
viewport, etc.). The fix wraps it in `.catch(log.warn)` and continues.
The test still reports its result. The cluster phase still records the
`screenshotPath` even if the file was not written — see § 4.3 caveat.

If we want to be strict (only record the path when the file exists), we
would need a feedback channel from execute → cluster carrying which
artifacts were actually written. This is a 2x-larger change. **Defer.**
For v0.1: paths are recorded optimistically; the retest path uses
`fs.existsSync` before reading.

### 7.4 HAR is a stub

`executeUiTest` writes an empty-but-valid HAR. This means consumers
believe network was captured when it wasn't. Document in PR. Track as
follow-up (`SPEC_NETWORK_HAR_CAPTURE.md`) tied to camofox-mcp v0.2 which
will expose `network.entries`.

### 7.5 Map-based contract on cluster phase

Adding a required `occurrenceIdByTestId` to `ClusterOptions` is a
breaking change to the cluster phase API. Internal-only: nothing outside
`packages/cli/src/cli/run.ts` calls `runCluster`. No external callers.

### 7.6 Dual writes

The previous code called `writeActionLog` from inside the inner catches.
After 4.2 those calls move to `finally`. **Verify** that no inner code
path returns without the `finally` running — Node's `try/finally` always
runs the finally block on return, throw, or normal exit. Safe.

## 8. Acceptance Criteria

A1. After `bughunter run` against a project that produces at least 5
clusters with `fullArtifacts: true`, the script in § 5.3 exits 0:
`fs.existsSync(occ.actionLogPath)` is true for **every** occurrence with
`fullArtifacts: true` in `bugs.jsonl`.

A2. The Spoonworks reproduction case is fixed:
`bughunt fix` against cluster `vnavmbuj933ze1uljy8b7mc9`-style
`missing_state_change` clusters reads the action log, replays the click,
and produces a verdict of `verified_fixed`, `partially_verified`, or
`not_fixed` based on the **actual** retest outcome — not on a missing
file.

A3. `npx vitest run` is green, including the new tests in § 5.1 and § 5.2.

A4. `npx tsc --noEmit` is green: every `TestResult` constructor in
`execute.ts` (six sites total: two normal returns, two
`infrastructureFailure` returns inside `withTab`, the outer-catch return,
and the `runTest` synthetic infra return) sets `occurrenceId: string`.

A5. `runCluster` throws (not silently fails) when called without an
`occurrenceIdByTestId` entry for a `testId` that appears in `detections`.

A6. The screenshot file `${runDir}/screenshots/<occurrenceId>.png`
exists for every UI occurrence with `fullArtifacts: true` after a real
run, given camofox-mcp is reachable. (Not enforced for API occurrences.)

A7. The DOM file `${runDir}/dom/<occurrenceId>.html` exists for every UI
occurrence with `fullArtifacts: true` whose `postSnapshot` was non-null.

A8. The console log file `${runDir}/console/<occurrenceId>.log` exists
for every UI occurrence with `fullArtifacts: true` (may be empty).

A9. The HAR stub file `${runDir}/network/<occurrenceId>.har` exists for
every UI occurrence with `fullArtifacts: true` and parses as valid JSON
matching the HAR 1.2 envelope.

A10. No new top-level files outside the `Files to Touch` table. No
introduction of `as any`. No function in the changed files exceeds 40
lines after the refactor; if `executeUiTest` does, split it into
`executeUiTestInner` (the `withTab` body) + `persistArtifacts` +
`executeUiTest` (the try/finally wrapper).
