# SPEC — retest fix: replay must resolve relative URLs

**Status:** Draft 1 — ready for `@coder` · **Author:** `@architect` (Opus) · **Date:** 2026-04-30 · **Sibling specs:** `SPEC_RETEST_FIX_STATIC_RERUN.md`, `SPEC_PLAN_FIX_HTTP_METHOD_FILTER.md`

The retest tool calls `browser.navigate(url)` with the literal `url` field from the action-log JSON. Action-logs commonly record `url: "/"` and `baseUrl: "/"` (relative). Camofox-mcp's `navigate` tool validates `url` as absolute via Zod (`z.string().url()`), so every replay attempt against a relative-URL action-log fails with:

```
camofox navigate error: MCP error -32602: Input validation error:
[{ "validation": "url", "code": "invalid_string", "message": "Invalid url", "path": ["url"] }]
```

Surfaced during the OpeningBell autofix loop: cluster `t1aakl3xeg81v95egpsa875i` (focus_lost_after_action) had 9 occurrences; 8 of them returned `passed: false` with the "Invalid url" error. The fix code (RouteFocus client component) was logically correct but the retest couldn't validate it.

---

## 1. Objective

Two fixes, belt-and-suspenders:

1. **Read-side fix (`repro/replay.ts`):** before each `browser.navigate(url)` call, resolve the action-log's `url` against the run's `appBaseUrl`. Old action-logs immediately become replayable.
2. **Write-side fix (`repro/action-log.ts`):** record absolute URLs at the time of writing — `url: "http://localhost:3010/"`, `baseUrl: "http://localhost:3010"`. New action-logs become self-contained.

Both fixes ship together because (a) old action-logs already exist in `.bughunter/runs/*/action-logs/` and need to keep working, and (b) future runs should produce self-contained logs that don't depend on resolution context.

**In scope:**
- `replay.ts` URL resolution before navigate
- `action-log.ts` writer: record absolute URLs
- Unit tests for both paths
- No changes to action-log JSON schema (the fields are already typed as `string`; we just change what we put in them)

**Out of scope:**
- Changing the action-log schema shape
- Changing camofox-mcp's `navigate` validation (already correct — absolute URLs are the right contract)
- Bug 2 (static-detector retest) and bug 3 (planner method filter) — separate specs

**Acceptance:**
- Re-run the t1aakl retest with this fix: passedOccurrences should match the actual fix's correctness (not 1/9 anymore due to URL validation noise).
- Existing tests pass.
- New tests cover relative + absolute URL paths.

---

## 2. Existing code map

### 2.1 Files to read before writing any code

| File | Why |
|---|---|
| `packages/cli/src/repro/replay.ts` | The retest replayer. Find the `browser.navigate(...)` call inside `executeStep` for `kind === 'navigate'`. The fix wraps that call with URL resolution. |
| `packages/cli/src/repro/action-log.ts` | The action-log writer. `writeActionLog` builds the JSON. The fix changes what `url` and `baseUrl` get set to. |
| `packages/cli/src/types.ts` | `ActionLog`, `ActionLogStep` types. No schema changes — `url` is already `string`. |
| `packages/cli/src/ops/retest.ts` | Calls `replayActionLog` with `appBaseUrl` from config. Confirm the `appBaseUrl` is already passed through; if not, plumb it. |
| `packages/cli/src/phases/execute.ts` | Where action-logs are recorded during a normal run. `appBaseUrl` is in scope here; pass it to the action-log writer. |
| `packages/cli/src/repro/replay.test.ts` | Existing unit tests. Mirror the pattern for new tests. |

### 2.2 Patterns to follow

- **No new dependencies.** Use `new URL(maybeRelative, appBaseUrl).toString()` from the WHATWG URL API (built into Node).
- **Discriminated-union returns** for the resolution helper: never throw, return a structured error if resolution fails.
- **Backward compatibility.** The replay-side fix MUST handle action-logs that have absolute URLs already (just pass through), relative URLs (resolve against appBaseUrl), and bare paths starting with `/` (resolve). All three appear in real artifacts.

### 2.3 DO NOT

- Do NOT modify `camofox-mcp` — its absolute-URL validation is correct.
- Do NOT change the `ActionLog` JSON shape (just the values).
- Do NOT introduce a new helper file. Add the resolver as a small helper function near where it's called.

---

## 3. Implementation

### 3.1 Read-side: `repro/replay.ts`

Add a small resolver:

```ts
/**
 * Resolve a (possibly relative) action-log URL against the run's appBaseUrl.
 * Returns the absolute URL string, or null if both inputs are invalid.
 */
function resolveActionLogUrl(maybeRelative: string, appBaseUrl: string | undefined): string | null {
  // Already absolute?
  try {
    const u = new URL(maybeRelative);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch { /* not absolute — fall through */ }

  // Need appBaseUrl to resolve.
  if (appBaseUrl === undefined || appBaseUrl === '') return null;
  try {
    return new URL(maybeRelative, appBaseUrl).toString();
  } catch {
    return null;
  }
}
```

Use it before every `browser.navigate(url)` call in `executeStep`. If resolution returns `null`, return an `OccurrenceResult` with `passed: false, error: 'replay_url_unresolvable: ...'` instead of letting camofox throw.

`replayActionLog` already accepts `appBaseUrl` per current signature OR via a config object — confirm during impl. If not, plumb it through; the caller `retest.ts` has it from `loadConfig(projectDir)`.

### 3.2 Write-side: `repro/action-log.ts`

Currently `writeActionLog(occurrenceId, runId, role, page, baseUrl, actions)` writes whatever `baseUrl` and `page` are passed in. The callers (in `phases/execute.ts`) currently pass relative paths.

Two options:

- **Option A (preferred):** keep the writer signature unchanged; have callers in `phases/execute.ts` resolve the relative `page` against `appBaseUrl` before calling `writeActionLog`. The writer becomes a passthrough.
- **Option B:** add `appBaseUrl` to the writer signature and resolve there. Simpler at call sites but couples the writer to a config detail.

Pick Option A — fewer files to touch, keeps the writer pure. Add the same `resolveActionLogUrl` helper (or share via a tiny `repro/url-resolve.ts`).

Per-step `actions[].url` should be absolute too. Most existing call sites in `phases/execute.ts` already build action-step objects locally; resolve relative URLs at construction.

### 3.3 Tests

- **`repro/replay.test.ts`:**
  - Action-log with absolute URL → navigate called with same value
  - Action-log with relative URL `/login` + `appBaseUrl: "http://localhost:3010"` → navigate called with `http://localhost:3010/login`
  - Action-log with `/` + appBaseUrl → navigate called with `http://localhost:3010/`
  - Action-log with relative URL but no appBaseUrl → result `{passed: false, error: replay_url_unresolvable: ...}` (no throw)
  - Action-log with garbage URL → same result
- **`repro/action-log.test.ts`:** action-log writer caller in `phases/execute.ts` produces JSON with absolute URL when given relative `page`. Mock `appBaseUrl` and assert the written file contains `"url": "http://localhost:3010/login"` not `"url": "/login"`.

---

## 4. Edge cases

### EC-1. Action-log records `baseUrl: ""` (empty string)
Treat as relative-with-no-baseUrl. Resolution falls through; return unresolvable error.

### EC-2. Action-log records `url: "javascript:void(0)"`
URL constructor parses but protocol is `javascript:`. We reject (only http/https). Mark unresolvable.

### EC-3. Action-log records absolute URL but on a different host than `appBaseUrl`
Honor what's in the action-log (the recording was authoritative). Don't override.

### EC-4. `appBaseUrl` is `http://localhost:3010` (no trailing slash) and url is `/dashboard`
`new URL("/dashboard", "http://localhost:3010")` → `http://localhost:3010/dashboard`. Correct.

### EC-5. Existing artifacts have a mix of absolute and relative URLs
Resolver handles both transparently.

---

## 5. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| New unit tests pass | `npm test -- replay.test` and `action-log.test` |
| Existing tests still pass | `npm test` |
| `npx tsc --noEmit` clean | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| t1aakl retest re-run on the OpeningBell run produces meaningful pass/fail counts (not all 8 with "Invalid url") | manual: `bughunter retest <run> t1aakl --base main --branch <main-with-fix>` |

---

## 6. Files to touch

- `packages/cli/src/repro/replay.ts` (resolver helper + use it before navigate)
- `packages/cli/src/repro/action-log.ts` (no change if Option A; the resolution happens at the caller)
- `packages/cli/src/phases/execute.ts` (resolve `page` and per-step `url` against `appBaseUrl` before calling `writeActionLog`)
- `packages/cli/src/repro/replay.test.ts` (new tests)
- `packages/cli/src/repro/action-log.test.ts` OR `packages/cli/src/phases/execute.test.ts` (new tests for write side)

5-6 files, ≤80 lines of net change.

---

## 7. Negative requirements

- Do not introduce a new dep.
- Do not change camofox-mcp.
- Do not change ActionLog JSON shape.
- Do not silently swallow unresolvable URLs — surface as a structured error.
- Do not break existing absolute-URL action-logs.

---

## 8. Risks

- **Risk: `appBaseUrl` is unset in some test fixtures.** Mitigated by EC-1 fallback.
- **Risk: caller code paths in `phases/execute.ts` are scattered.** Audit all `writeActionLog` callers; the action-log step `url` is set in multiple places (navigate, click-with-href, submit). Each needs the same resolution.
