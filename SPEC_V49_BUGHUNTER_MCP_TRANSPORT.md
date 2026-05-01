# SPEC — v0.49 "BugHunter consumes camofox via real MCP transport"

**Status:** Draft 1 — ready for `@coder` assignment
**Author:** `@architect` (Opus, ultrathink)
**Date:** 2026-04-30
**Depends on:** camofox-mcp v0.6+ (the merged V20/V22/V23 tools — `network_fault`, `clear_network_fault`, `get_network_fault`, `in_flight_requests`, `init_script`, `clear_init_scripts`, `set_timezone`, `clear_timezone`, plus `set_viewport` from PR #45 — total 19 registered tools); `@modelcontextprotocol/sdk` 1.29.0 (already in `packages/cli` and `packages/mcp` deps); V30/V31 server-side MCP patterns (read-side / write-side tools — same SDK version, parallel client patterns).
**Sibling:** v0.32 (deterministic mode), v0.30/v0.31 (BugHunter-as-MCP-server).

---

## 1. Problem

BugHunter today consumes camofox via `packages/cli/src/adapters/browser-mcp.ts` (`CamofoxBrowserMcpAdapter`). The class name says "Mcp" but the implementation hand-rolls JSON-RPC over `fetch`: builds the envelope (`{jsonrpc:'2.0', id:1, method:'tools/call', params:{name, arguments}}`), parses both `application/json` and `text/event-stream` responses, classifies errors from string matching on the result-text. The transport target is the camofox-mcp HTTP server at `127.0.0.1:3104/mcp` (an MCP server) — so envelope-wise we are talking JSON-RPC, but we bypass the official `@modelcontextprotocol/sdk` `Client` and `StreamableHTTPClientTransport`. Three concrete consequences:

1. **Naming dishonesty.** The class advertises "Mcp" but does not use the SDK. New contributors reading the file see `fetch` + manual envelope assembly and reasonably conclude camofox is "just an HTTP API" — which it is at `9377`, but the adapter is talking to `3104`, the MCP wrapper. The mismatch causes wrong fixes and wrong tests.
2. **Protocol drift risk.** Hand-rolled JSON-RPC envelopes diverge from the SDK as the spec evolves. The SDK already moved from sessionful HTTP to streamable-HTTP with `mcp-session-id` headers; our adapter ignores session headers, ignores progress notifications, and treats SSE as a single-frame trick. The day camofox-mcp emits a multi-frame response (e.g. progress on `screenshot`), we silently take only the last `data:` line.
3. **Lost capabilities.** Without the SDK Client we cannot use `client.listTools()` (capability discovery), `client.notification()` (cancellation), resource subscriptions, or stdio transport. We therefore cannot adopt patterns the V30/V31 BugHunter-as-server work depends on, and we cannot run camofox-mcp as a per-run subprocess for process isolation.

The fix: replace the bespoke transport with the official SDK Client. Keep the public adapter surface (the `BrowserMcpAdapter` interface) byte-for-byte stable so all 42 call-sites compile unchanged. Rename the dishonest class. Ship a transport configuration knob so users who genuinely want raw HTTP-to-camofox-browser at port 9377 — useful for debugging when the MCP wrapper is suspect — can flip a switch without touching code.

---

## 2. Boundaries

### 2.1 In scope

- Replace the hand-rolled `mcpCall<T>` JSON-RPC plumbing in `packages/cli/src/adapters/browser-mcp.ts` with a thin wrapper around `Client.callTool()` from `@modelcontextprotocol/sdk/client/index.js`.
- Add a `BrowserTransport` discriminated union and config field selecting between two implementations:
  - `mcp-http` (default) — `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport`. Same wire format as today; correct envelope handling.
  - `mcp-stdio` (opt-in) — `Client` + `StdioClientTransport`. BugHunter spawns a per-run camofox-mcp subprocess. Process-isolated; useful for CI sandboxes and parallel runs that cannot share a daemon.
- Rename the existing class `CamofoxBrowserMcpAdapter` to `CamofoxBrowserHttpAdapter` (the legacy hand-rolled HTTP-JSON-RPC path). Keep it functional for one minor version with a deprecation `console.warn` on construction.
- Introduce a new `CamofoxBrowserMcpAdapter` (same name, new implementation) that uses the SDK Client. Both implement the same `BrowserMcpAdapter` interface — call-sites do not change.
- Map every adapter method to its camofox-mcp tool. Document every tool name, argument shape, and response shape.
- Connection lifecycle: lazy init on first call, single Client per BugHunter run, graceful close on run end (and on adapter `dispose()`).
- Auth: pass-through `Authorization: Bearer <key>` and any user-supplied extra headers to the SDK transport. Source: `config.browserMcpAuthKey` or env `CAMOFOX_MCP_KEY`. Optional — camofox-mcp's local HTTP transport does not require auth today, but the field is reserved for the per-client-API-key pattern V30/V31 introduced.
- Error mapping: SDK errors (`McpError`, `RequestError`) → existing `BrowserMcpError` kinds. Map `isError:true` content responses to `BrowserMcpError` with the same kinds the current `classifyRpcError` produces. Callers see no change.
- Tests: replace transport-mocking pattern in `browser-mcp.test.ts` to mock the SDK `Client`. Add an integration test against a live camofox-mcp subprocess (gated behind `RUN_INTEGRATION=1`).
- Migration: default `browserTransport: 'mcp-http'`. The old class stays exported (deprecated) for one minor; remove in v0.50.

### 2.2 Explicitly out of scope

- **Adding new MCP tools to camofox-mcp.** Each new tool is a separate camofox-mcp PR. V49 only consumes what camofox-mcp already exposes.
- **Replacing camofox-mcp with a direct-MCP server on camofox-browser at port 9377.** That removes a hop but requires writing an MCP server inside camofox-browser. Separate decision; not V49.
- **Refactoring the snapshot-resolution pipeline (`browser-mcp-snapshot.ts`).** It already operates on the parsed snapshot string and is transport-agnostic. It moves to the new adapter unchanged.
- **Public-type breaking changes.** All 42 call-sites importing `BrowserMcpAdapter`, `TabScope`, `NavigateResult`, etc. must compile without modification.
- **`clickByHint` semantics.** It is synthesized in BugHunter via `evaluate(...)` and is NOT a camofox-mcp tool. It stays in BugHunter, unchanged.
- **HTTP/2, websocket, custom-transport experiments.** SDK supports streamable-HTTP and stdio. We ship those two; nothing else.
- **Fix the `routeFulfill` no-tool-support fallback.** The current optional `routeFulfill?` method in the interface stays optional. If camofox-mcp doesn't expose `route_fulfill`, the adapter throws and the caller skips with `no_route_fulfill_support`. V49 does not change that contract.

### 2.3 External dependencies

- `@modelcontextprotocol/sdk@1.29.0` — already in `packages/cli/package.json`. No new dep.
- `node:child_process` — for the stdio transport, used only when `browserTransport: 'mcp-stdio'`.
- camofox-mcp running at `config.browserMcpUrl` (default `http://127.0.0.1:3104`) — same as today.

---

## 3. Architecture decision

Three options were considered. **Option β is recommended.**

### Option α — Single class, MCP only

Replace `CamofoxBrowserMcpAdapter` with one class that uses the SDK Client over streamable-HTTP. Delete the hand-rolled fetch path. Single transport, single class.

**Pro:** smallest diff. Fewer code paths. No "two ways to do the same thing."
**Con:** loses the escape hatch when the SDK or camofox-mcp misbehaves. We cannot debug "is it the SDK envelope or the wire?" without reverting the patch. Users running on camofox-browser directly (port 9377, REST endpoints — no MCP wrapper at all) are forced to install camofox-mcp; today they can hit the wrapper or not. Single-class loses that flexibility.

### Option β — Two implementations, one interface (RECOMMENDED)

Keep the `BrowserMcpAdapter` interface unchanged. Two concrete classes:

- `CamofoxBrowserMcpAdapter` (new implementation) — `@modelcontextprotocol/sdk` `Client` + `StreamableHTTPClientTransport` (or `StdioClientTransport`). Default.
- `CamofoxBrowserHttpAdapter` (renamed from current `CamofoxBrowserMcpAdapter`) — hand-rolled fetch + JSON-RPC envelope. Deprecated. Kept for one minor.

User selects via `browserTransport: 'mcp-http' | 'mcp-stdio' | 'http-legacy'` in config. Default `'mcp-http'`. The `'http-legacy'` value emits a deprecation warning on construction.

**Pro:** honest naming, backward compat, debug escape hatch, performance escape hatch if the SDK adds non-trivial overhead under load. Tests can pin to either implementation. Removes the "what does Mcp mean here?" confusion forever.
**Con:** carries dead code for one minor. ~250 lines of legacy adapter we'll delete in v0.50.

### Option γ — Hybrid (stdio for dev, HTTP for production)

Auto-detect: if `CAMOFOX_MCP_PORT` env is set, use HTTP; otherwise spawn stdio. Single class internally; transport chosen per-process.

**Pro:** lowest config burden.
**Con:** magic. Two transports collapsed into one class violates "explicit boundaries." Stdio has its own failure modes (subprocess lifecycle, stderr piping, signal handling) that deserve a separate code path and separate tests. Hybrid hides which transport is in use, defeating the debugging-clarity gain that motivates the rename.

### Decision: β

Honesty about what the class does (Mcp vs. Http vs. legacy) outweighs the cost of carrying ~250 lines for a release. The escape hatch is not theoretical — within the last 30 days we shipped V18/V20/V22/V23, each of which surfaced a camofox-mcp bug we needed to bisect. Having both transports available shrinks bisect time.

The two transports inside the new MCP adapter (`mcp-http` and `mcp-stdio`) are chosen via config; same class, the SDK abstracts the transport. This collapses what would be three classes back to two.

---

## 4. MCP client setup

### 4.1 Client lifecycle

```ts
// adapters/browser-mcp.ts (new implementation)
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

export class CamofoxBrowserMcpAdapter implements BrowserMcpAdapter {
  private client?: Client;
  private transport?: StreamableHTTPClientTransport | StdioClientTransport;
  private currentTabId?: string;
  private connectPromise?: Promise<void>;

  constructor(
    private readonly opts: {
      mode: 'http' | 'stdio';
      url?: string;          // mode==='http'
      command?: string;      // mode==='stdio'
      args?: string[];       // mode==='stdio'
      env?: Record<string, string>;
      authKey?: string;
      extraHeaders?: Record<string, string>;
    }
  ) {}

  private async ensureConnected(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connectPromise) { await this.connectPromise; return this.client!; }
    this.connectPromise = this.connect();
    await this.connectPromise;
    return this.client!;
  }

  async dispose(): Promise<void> {
    if (this.client) { await this.client.close().catch(() => {}); this.client = undefined; }
    if (this.transport) { await this.transport.close().catch(() => {}); this.transport = undefined; }
  }
}
```

**Lazy init.** First call to `navigate()` triggers `ensureConnected()`. Subsequent calls reuse the singleton client. Concurrent first-callers race-share the same `connectPromise`.

**Single client per run.** `cli/run.ts`, `cli/replay.ts`, `cli/scope.ts`, `ops/retest.ts`, `cli/doctor.ts` each construct one adapter; the run-end hook calls `adapter.dispose()` in a `finally` block.

**Graceful close.** `dispose()` closes the client, then the transport. Both are best-effort (`.catch(() => {})`); if the daemon already exited, we don't crash the BugHunter run on cleanup.

### 4.2 Auth

```ts
const transport = new StreamableHTTPClientTransport(
  new URL(this.opts.url ?? 'http://127.0.0.1:3104/mcp'),
  {
    requestInit: {
      headers: {
        ...(this.opts.authKey !== undefined ? { Authorization: `Bearer ${this.opts.authKey}` } : {}),
        ...(this.opts.extraHeaders ?? {}),
      },
    },
  }
);
```

Auth key resolution order: `config.browserMcpAuthKey` → `process.env.CAMOFOX_MCP_KEY` → undefined (no auth). camofox-mcp's local HTTP transport at `127.0.0.1:3104` does not require auth today, so the default is "no header"; the field is wired so V30/V31 per-client-API-key patterns apply when the deployment moves off loopback.

### 4.3 Tool-call dispatcher

```ts
private async tool<T>(name: string, args: Record<string, unknown>, expect: 'json' | 'image' = 'json'): Promise<T> {
  const client = await this.ensureConnected();
  let res: Awaited<ReturnType<typeof client.callTool>>;
  try {
    res = await client.callTool({ name, arguments: args });
  } catch (err) {
    throw new BrowserMcpError('transport', `camofox ${name} transport error: ${String(err)}`, undefined, err);
  }
  if (res.isError === true) {
    const msg = textOf(res.content) ?? 'Unknown MCP tool error';
    throw new BrowserMcpError(classifyRpcError(msg, name), `camofox ${name} error: ${msg}`);
  }
  if (expect === 'image') return parseImageContent(res.content) as T;
  return parseTextContent(res.content, name) as T;
}
```

**Note:** `client.callTool` returns `{ content: ContentBlock[], isError?: boolean }`. We reuse the existing `parseTextContent` / `parseImageContent` helpers from `browser-mcp.ts` — they already accept the `content` array shape.

### 4.4 Error mapping

| SDK error | Mapped `BrowserMcpError.kind` |
|---|---|
| `McpError` with code `-32700` (parse error) | `transport` |
| `McpError` with code `-32601` (method not found) | `transport` (tool name typo from us — bug) |
| `McpError` with code `-32603` (internal error) | derived from `classifyRpcError(message, toolName)` |
| Network `fetch` exception | `transport` |
| Result `isError: true` + content text | `classifyRpcError(text, toolName)` |
| Stdio: subprocess exited mid-call | `transport` with cause set to `{ code: 'ENOEXEC', signal }` |

The dispatcher preserves the existing error contract: every method that today throws `BrowserMcpError` with kind `X` continues to throw `BrowserMcpError` with kind `X` for the same upstream condition.

---

## 5. Per-method mapping

The `BrowserMcpAdapter` interface has 16 methods (plus 2 optional: `setViewport`, `routeFulfill`). Each maps to one or more camofox-mcp tool calls. Methods marked **synthesized** are composed in BugHunter via `evaluate` and have no direct camofox-mcp tool.

| # | Adapter method | camofox-mcp tool(s) | Argument transform | Response transform |
|---|---|---|---|---|
| 1 | `navigate(url, extraHeaders?)` | `navigate` | `{url}` (new tab) or `{tabId, url}` (existing) | result→`{url: r.finalUrl ?? r.url ?? url, title: r.title}`; cache `currentTabId = result.tabId` |
| 2 | `openTab(url, extraHeaders?)` | `navigate` | `{url}` (always new tab) | result→`{tabId, finalUrl: r.finalUrl ?? r.url ?? url, title}` (does NOT mutate `currentTabId`) |
| 3 | `click(selector)` (string) | `evaluate` (synthesized via `runEvaluateClick`) | inline JS expr | `{clicked: true}` |
| 3b | `click(selector)` (StructuredSelector) | `snapshot` then `click` | first call snapshot → resolve ref → call click `{tabId, ref}` | `{clicked: true}`; retry once on `element_not_found` |
| 4 | `type(selector, text)` | `snapshot` then `type` | resolve ref via snapshot → `{tabId, ref, text, submit:false}` | `{typed: true}`; retry once on `element_not_found` |
| 5 | `scroll(_sel, direction, distance?)` | `scroll` | `{tabId, direction: toCamofoxScrollDirection(direction), amount: distance ?? 500}` | `{scrolled: true}` |
| 6 | `setViewport?(w, h)` | `set_viewport` (preferred) → `evaluate` (fallback for old camofox-mcp) | `{tabId, width, height}` | `{ok:true}` or `{ok:false, reason}` |
| 7 | `back()` / `forward()` / `refresh()` | NOT exposed by camofox-mcp today — synthesized via `evaluate('history.back()')` / `'history.forward()'` / `'location.reload()'` | inline JS expr | `{ok:true}` |
| 8 | `screenshot(outputPath?)` | `screenshot` | `{tabId, fullPage:false}` | image base64 → optionally `fs.writeFileSync` → `{path, data}` |
| 9 | `evaluate(script)` | `evaluate` | `{tabId, expression: script}` | `{value: r.result ?? r.value}` |
| 10 | `snapshot()` | `snapshot` | `{tabId}` | `{snapshot: r.snapshot}` |
| 11 | `cookies(urls?)` | `cookies` | `{tabId, urls?}` | passthrough (already shaped) |
| 12 | `listTabs()` | `list_tabs` | `{}` | result.tabs → `{id: t.tabId ?? t.id ?? '', url, title}` |
| 13 | `closeTab(tabId)` | `close_tab` | `{tabId}` | `{closed: true}`; clear `currentTabId` if matched |
| 14 | `closeTabExplicit(tabId)` | `close_tab` | `{tabId}` | `void`; does NOT mutate `currentTabId` |
| 15 | `withTab(url, extraHeaders, fn)` | `navigate` (open) → fn(scope) → `close_tab` | `openTab` then bind a `TabScope` to that tabId; close in finally | passthrough of `fn`'s result |
| 16 | `clickByHint(hint)` | **synthesized** — `evaluate` with three CSS / text strategies (testId → ariaLabel → text) | inline JS via `evaluateClickByCss` / `evaluateClickByText` | `{clicked, matchedBy}` or `{clicked:false, reason}` |
| 17 | `routeFulfill?(scope, response)` | `route_fulfill` (camofox-mcp v0.7+ when available) → otherwise rejects, caller skips with `no_route_fulfill_support` | `{tabId, method, path, status, body, contentType, bodyHash?}` | unregister fn calls `route_fulfill_remove` |

### 5.1 Methods NOT in camofox-mcp (synthesized)

- `back`, `forward`, `refresh` — implemented as `evaluate('history.back()' / 'history.forward()' / 'location.reload()')`. camofox-mcp does NOT register tools for these. The current adapter has no public methods for them either, but they are referenced in the spec context; if any caller adds them, they go through `evaluate`.
- `clickByHint` — three-strategy evaluate-based click. Not a camofox-mcp tool. Kept in adapter; transport-agnostic.
- `clickWithObservation` (TabScope only) — runs `runEvaluateClick` for string selectors, falls back to ref+click for structured. Already synthesized; no transport change.

### 5.2 Network-fault tools (V20)

- `network_fault` → `setNetworkFault?(opts)` (new optional method on the interface, mirrors camofox tool args 1:1).
- `clear_network_fault` → `clearNetworkFault?()`.
- `get_network_fault` → `getNetworkFault?()`.

These are NOT in the current `BrowserMcpAdapter` interface — they were added in V20 in test-runner code that calls a camofox-mcp tool directly via a different path. V49 does NOT promote them to interface methods (out of scope — interface stability). The new adapter exposes a generic `tool<T>(name, args)` method (visibility: `internal` to BugHunter, not `private`) so V20-era code can call `network_fault` without adding interface bloat. This is a pragmatic concession to V49's "no interface change" rule: instead of adding 3+5 new methods, expose one generic dispatcher.

### 5.3 In-flight requests (V22) and init-script + timezone (V23)

Same pattern as 5.2 — call via the generic `tool<T>(name, args)` dispatcher. V49 does not lift these to interface methods. If a future spec wants to type the V20/V22/V23 tools, that is a follow-up — the dispatcher is the seam.

---

## 6. Performance characterization

### 6.1 Per-call overhead

| Transport | Wire format | Round-trips | Estimated p50 latency (loopback) | Notes |
|---|---|---|---|---|
| Direct HTTP to camofox-browser (port 9377) | REST JSON | 1 | ~1.5 ms | Theoretical baseline. NOT actually used by BugHunter today. |
| Hand-rolled JSON-RPC over HTTP to camofox-mcp (current) | JSON-RPC envelope | 1 | ~2 ms | Adds JSON-RPC envelope; camofox-mcp internally calls camofox-browser, so it's 2 hops. |
| SDK Client + StreamableHTTPClientTransport (V49 default) | JSON-RPC envelope (SDK) | 1 | ~2.5 ms | Adds SDK Client routing + capability negotiation on first call. |
| SDK Client + StdioClientTransport (V49 opt-in) | JSON-RPC over framed pipe | 1 | ~1.8 ms | No network stack; framed JSON over `child_process` pipe. Lower variance. |

### 6.2 Run-level impact

Exhaustive 24h run averages ~100k browser tool calls (p95 from recent telemetry: navigate+snapshot+click+evaluate dominate). Per-call delta vs current:

- mcp-http: +0.5 ms × 100k ≈ 50 s of overhead per run. **Negligible** (run budget is 24h).
- mcp-stdio: -0.2 ms × 100k ≈ 20 s saved per run. **Negligible** but slightly faster.

Connection cost (one-time, not per-call):

- mcp-http: ~30 ms for first `client.connect()` + capability handshake.
- mcp-stdio: ~120 ms (subprocess spawn + Node startup of camofox-mcp). Amortized over 100k calls = noise.

### 6.3 Concurrency

The current adapter is concurrency-safe (no shared in-flight state). The new SDK Client is concurrency-safe per the SDK contract; multiple `callTool` calls can be in flight concurrently on one Client. BugHunter executes tests in parallel (default `concurrency:4`), and each parallel test gets its own `TabScope` bound to a tabId — they share the Client but not the tab. No locking needed.

### 6.4 Recommendation

**Default to `mcp-http`.** It matches what users have today (camofox-mcp daemon at port 3104 already running, managed by pm2 per `MEMORY.md`). The +50s/run cost is invisible.

**`mcp-stdio` is opt-in for two scenarios:**

1. CI environments where camofox-mcp is not pre-deployed. `bughunter run --browser-transport=mcp-stdio --camofox-mcp-cmd=/opt/camofox-mcp/dist/index.js` spawns a per-run subprocess. Run isolation by default.
2. Parallel BugHunter runs against different camofox-browser instances. Each BugHunter spawns its own camofox-mcp pinned to its camofox-browser. No port-3104 contention.

---

## 7. Test strategy

### 7.1 Unit tests — mock the SDK Client (`packages/cli/src/adapters/browser-mcp.test.ts`)

Replace today's `vi.spyOn(global, 'fetch')` mocks with mocks of the SDK `Client.callTool`. Pattern:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    callTool: vi.fn(),
  })),
}));
```

For each adapter method, assert:

- The SDK call shape: `client.callTool` was called with `{name: 'navigate', arguments: {url: 'http://...'}}`.
- The response shape conversion: tool returns `{content: [{type:'text', text: '{"tabId":"t1","url":"http://x"}'}]}` → adapter returns `{url:'http://x', title: undefined}`.
- Error mapping: tool returns `{isError: true, content: [{type:'text', text:'No element found'}]}` → adapter throws `BrowserMcpError('element_not_found', ...)`.
- Retry: structured `click` with first-call `element_not_found` triggers a second `snapshot` + second `click`.

Coverage gate: every method in §5's mapping table has at least one happy-path test, one error-path test, and (for click/type) one retry test. Existing `browser-mcp.test.ts` test count grows from 14 to ~34 (16 methods × 2-3 paths).

### 7.2 Snapshot tests — tool-call shapes

A separate test file `browser-mcp.shape.test.ts` records the exact `callTool` argument object for each method. Vitest snapshot-matches them. Catches accidental argument-shape drift.

```ts
it('navigate args shape', async () => {
  const adapter = makeAdapter();
  await adapter.navigate('http://x');
  expect(callToolSpy.mock.calls[0][0]).toMatchSnapshot();
});
```

### 7.3 Integration test — live camofox-mcp subprocess

Gated behind `RUN_INTEGRATION=1`:

```ts
describe.skipIf(!process.env.RUN_INTEGRATION)('live camofox-mcp', () => {
  it('navigates a real page over stdio transport', async () => {
    const adapter = new CamofoxBrowserMcpAdapter({
      mode: 'stdio',
      command: 'node',
      args: ['/opt/camofox-mcp/dist/index.js'],
    });
    const result = await adapter.navigate('http://localhost:8787');
    expect(result.url).toContain('localhost:8787');
    await adapter.dispose();
  });
});
```

Runs in CI on a job that pre-installs camofox-browser + camofox-mcp. Local-dev gate is `RUN_INTEGRATION=1 npm test`.

### 7.4 Backward-compat regression

`CamofoxBrowserHttpAdapter` (the renamed legacy class) keeps its existing tests. They run unchanged, proving the legacy path still works during the deprecation window.

### 7.5 End-to-end smoke

Aspectv3 nightly smoke runs with `browserTransport: 'mcp-http'` (the new default). Acceptance: smoke produces the same `summary.json` shape it produced on V48; `vision.called >= 1`; no new `transport` errors in `skippedReasons`.

---

## 8. Migration / rollout

### 8.1 Phasing

| Version | Default transport | Legacy class | Action |
|---|---|---|---|
| v0.49.0 (this spec) | `mcp-http` (SDK Client) | `CamofoxBrowserHttpAdapter` exported with deprecation warning | Ship the new adapter; default switches; update docs. |
| v0.49.x patches | `mcp-http` | Legacy still exported | Bug-fix only. |
| v0.50.0 | `mcp-http` | **Removed** | Delete legacy class. Anyone still using it gets a clean error pointing to the migration guide. |

### 8.2 Config migration

`packages/cli/src/config.ts` adds:

```ts
export const ConfigSchema = z.object({
  // ... existing fields ...
  browserMcpUrl: z.string().url().optional(),
  browserMcpAuthKey: z.string().min(1).optional(),  // NEW (V49)
  browserTransport: z.enum(['mcp-http', 'mcp-stdio', 'http-legacy']).default('mcp-http'),  // NEW (V49)
  browserMcpStdio: z.object({
    command: z.string().min(1),
    args: z.array(z.string()).optional(),
  }).optional(),  // NEW (V49) — required when browserTransport === 'mcp-stdio'
});
```

`bughunter init` prompts for `browserTransport` with default `mcp-http`. CLI flag `--browser-transport` overrides config.

### 8.3 Backward compat

Existing `bughunter.config.json` files without `browserTransport` default to `mcp-http`. The wire format is identical to the current bespoke implementation (same MCP server at `127.0.0.1:3104`), so no daemon change needed. Users who pinned `browserMcpUrl: 'http://127.0.0.1:3104'` in their config see no behavior difference.

### 8.4 Public API stability

`BrowserMcpAdapter` interface (the type) is unchanged. All 42 importing files compile without changes. The class export name changes:

- Before: `export class CamofoxBrowserMcpAdapter implements BrowserMcpAdapter`
- After: `export class CamofoxBrowserMcpAdapter implements BrowserMcpAdapter` (new SDK-based) AND `export class CamofoxBrowserHttpAdapter implements BrowserMcpAdapter` (renamed legacy).

The 6 construction sites (`run.ts`, `replay.ts`, `scope.ts`, `retest.ts`, `doctor.ts`, `init.ts`) update to call a factory:

```ts
// adapters/browser-mcp.ts
export function makeBrowserAdapter(config: ResolvedConfig): BrowserMcpAdapter | undefined {
  if (config.browserMcpUrl === undefined && config.browserTransport !== 'mcp-stdio') return undefined;
  switch (config.browserTransport) {
    case 'mcp-http':    return new CamofoxBrowserMcpAdapter({ mode: 'http', url: config.browserMcpUrl, authKey: config.browserMcpAuthKey });
    case 'mcp-stdio':   return new CamofoxBrowserMcpAdapter({ mode: 'stdio', command: config.browserMcpStdio!.command, args: config.browserMcpStdio?.args });
    case 'http-legacy': console.warn('[bughunter] browserTransport: http-legacy is deprecated; switch to mcp-http (SDK Client) before v0.50.'); return new CamofoxBrowserHttpAdapter(config.browserMcpUrl!);
  }
}
```

### 8.5 Migration guide (docs)

A short `docs/migrations/v49-browser-mcp.md` explains:

- What changed (transport).
- Why (honesty + capability discovery).
- For users with custom adapters: implement the same `BrowserMcpAdapter` interface as before; nothing changed.
- For users on `http-legacy`: flip to `mcp-http` and re-smoke. Wire format is identical; no behavior difference expected.

---

## 9. Edge cases

### EC-1. SDK Client first-call latency on cold start
`Client.connect()` performs a capability handshake (~30 ms). On a 24h run this is invisible; on a fast doctor-style ping (`bughunter doctor`) it's measurable. Mitigation: `doctor` calls `adapter.ping()` (synthesized — `client.listTools()`) once; the connect cost is paid in `ensureConnected()` and reused.

### EC-2. Multi-tab session management
Today the adapter holds `currentTabId` and threads it through. The SDK Client is stateless; tab state is camofox-server-side. V49 keeps `currentTabId` in the adapter — no protocol change. Concurrent `withTab()` calls from parallel tests all share the same Client but each binds a different `tabId`; no shared mutable state besides `currentTabId` (set only by `navigate()`, intentionally — `openTab()` deliberately does not).

### EC-3. Long-lived screenshots over MCP base64
camofox-mcp `screenshot` returns a base64 image inside an `image` content block. A 4K full-page screenshot is ~3 MB raw, ~4 MB base64, ~5 MB after JSON-RPC envelope wrapping. The SDK transport reads it in one chunk. Memory pressure: 5 MB × concurrency:4 = 20 MB transient; well within budget. No streaming needed.

### EC-4. SSE / chunked responses from camofox-mcp
The current hand-rolled adapter takes the LAST `data:` line of an SSE stream. The SDK Client correctly assembles multi-frame responses (e.g. progress notifications). V49 inherits correct behavior automatically. **One test asserts** that a hypothetical multi-frame response on `screenshot` is reassembled correctly (mock the transport to emit two `data:` lines; assert the adapter sees the final result, not the first frame).

### EC-5. Stdio transport: subprocess crash mid-call
`StdioClientTransport` emits an error when stderr-on-exit is non-zero or the process dies. The adapter's `tool<T>()` catches and rethrows as `BrowserMcpError('transport', ...)`. Subsequent calls trigger `ensureConnected()` again — the dead transport is recreated. Test: kill the subprocess externally, assert the next call respawns and succeeds.

### EC-6. Network-fault state across reconnect
camofox-mcp v0.6+ stores network-fault state in the camofox-browser context, not in camofox-mcp memory. So a stdio reconnect (new camofox-mcp subprocess) does NOT lose the fault — it's bound to the camofox-browser session. **However**: a tab-id is bound to a session, so respawning camofox-browser DOES lose state. Document. Tests that install a fault must not assume it survives a `dispose()` + new-adapter cycle.

### EC-7. Auth key leak in error messages
SDK error messages can include request headers in some failure modes. The dispatcher MUST strip `Authorization` from any rethrown error message. Test: cause a 401 by injecting a bad token; assert the rethrown `BrowserMcpError.message` does NOT contain `'Bearer'` or the token text.

### EC-8. tool name typo at our end
If the adapter calls a non-existent tool (e.g. typo `'click_'`), the SDK returns `McpError(-32601, 'method not found')`. We map to `transport` kind today but should ideally surface this as a programming error (assertion failure). V49 keeps it `transport` — the assertion would prevent forward-compat against newer camofox-mcp versions where tools may legitimately come and go.

### EC-9. Tool input-schema drift
camofox-mcp upgrades a tool's Zod schema (e.g. `network_fault.percent` becomes required where it was optional). Old adapter code passes the old shape; SDK call returns Zod-validation error. Map to `transport` with the original message. Test: simulate via mock — assert the error message contains the bad-arg name.

### EC-10. Streamable-HTTP session ID
The SDK's `StreamableHTTPClientTransport` may negotiate an `mcp-session-id` cookie/header on connect. Our previous hand-rolled fetch did NOT pass session IDs. camofox-mcp's HTTP transport (per `transports/http.ts`) uses `sessionIdGenerator: undefined` — sessionless. The new adapter inherits the SDK's session-aware behavior; if camofox-mcp later opts into sessions, the SDK transparently handles it. No code change needed.

### EC-11. `routeFulfill` under stdio
The optional `routeFulfill` method calls `route_fulfill` and `route_fulfill_remove` tools. If camofox-mcp doesn't expose them (older build), the SDK throws `McpError(-32601, 'method not found')`. The dispatcher maps to `transport`, but the caller (`routeFulfill`) catches and rejects so the upstream `optimistic_revert` test skips with `no_route_fulfill_support`. V49 does not change that contract; just verify it still works under SDK.

### EC-12. Concurrent dispose during in-flight call
`adapter.dispose()` called while a `callTool` is in flight. SDK behavior: `client.close()` cancels in-flight requests; `callTool` rejects with abort error. The dispatcher maps abort errors to `transport`. Calls in flight at dispose time are best-effort; the upstream phase is responsible for awaiting them before disposing. Document in the adapter doc-comment.

### EC-13. Stdio: `command` not found / not executable
`StdioClientTransport` constructor accepts `command` + `args`; if the binary is missing, `connect()` rejects with `ENOENT`. The adapter wraps it as `BrowserMcpError('transport', 'camofox-mcp subprocess failed to start: ...')`. Doctor-mode `bughunter doctor` should explicitly check for `command` existence and fail loudly with a fix suggestion (`brew install camofox-mcp` or whatever the install method is).

### EC-14. Header passthrough quirks (extraHeaders dropped today)
Current `navigate()` accepts `extraHeaders` but silently drops it (camofox v0.1 had no per-tab header passthrough). camofox-mcp likely still doesn't expose this. V49 keeps the silent-drop behavior for now; the parameter remains in the interface for forward compat. **NEW**: log at TRACE level when extraHeaders is non-empty so users discover the no-op.

---

## 10. Acceptance criteria

1. **Public interface unchanged.** `BrowserMcpAdapter`, `TabScope`, all exported types and method signatures are byte-identical to v0.48. `npx tsc --noEmit` passes in `packages/cli` with zero errors.
2. **All 42 call-sites compile unchanged.** `grep -l "BrowserMcpAdapter\|browser-mcp" packages/cli/src` returns the same set; no edits to the import sites except the 6 construction sites that now call `makeBrowserAdapter(config)`.
3. **All existing unit tests pass.** `npm test --filter=browser-mcp.test.ts` green. New shape-snapshot tests added; legacy tests unchanged.
4. **SDK Client is on the call path.** `grep -n "callTool\|@modelcontextprotocol/sdk/client" packages/cli/src/adapters/browser-mcp.ts` shows ≥10 references.
5. **Hand-rolled `fetch('/mcp')` is gone from the new adapter.** `grep -n "fetch.*\/mcp" packages/cli/src/adapters/browser-mcp.ts` returns zero. (The legacy `CamofoxBrowserHttpAdapter` keeps its fetch — that's fine.)
6. **Default transport is `mcp-http`.** Default config without an explicit `browserTransport` resolves to `'mcp-http'`. Confirmed via `bughunter doctor` output line `transport: mcp-http (SDK Client)`.
7. **Stdio mode works.** `RUN_INTEGRATION=1 npm test` includes a stdio-mode integration test that spawns camofox-mcp as a subprocess and successfully navigates a real page.
8. **Aspectv3 smoke green.** Smoke run on V49 reports identical `summary.json.discovery.visionBaselineTelemetry` shape and `vision.called >= 1`. Zero new `skippedReasons` entries vs v0.48.
9. **Legacy class deprecation warning.** Constructing `CamofoxBrowserHttpAdapter` (or selecting `browserTransport: 'http-legacy'`) emits a `console.warn` exactly once per process.
10. **No new runtime deps.** `git diff packages/cli/package.json` shows no additions. SDK is already present.
11. **Docs updated.** `docs/migrations/v49-browser-mcp.md` exists and explains the rename. README mentions `browserTransport` config field.
12. **Lint clean.** `npx eslint packages/cli --max-warnings 0` passes.

---

## 11. Files to touch / add

### 11.1 Files modified

| File | Change | Approx LOC delta |
|---|---|---|
| `packages/cli/src/adapters/browser-mcp.ts` | Replace transport internals; introduce `makeBrowserAdapter` factory; rename old class to `CamofoxBrowserHttpAdapter` (kept for backward compat); add new SDK-based `CamofoxBrowserMcpAdapter` | +250 / -120 |
| `packages/cli/src/adapters/browser-mcp-error.ts` | Add 1 line: ensure `classifyRpcError` handles SDK `McpError.code` mapping | +5 |
| `packages/cli/src/adapters/browser-mcp.test.ts` | Replace `fetch` mocks with `Client.callTool` mocks; add 20 new shape tests | +200 / -80 |
| `packages/cli/src/config.ts` | Add `browserTransport`, `browserMcpAuthKey`, `browserMcpStdio` fields to `ConfigSchema` | +12 |
| `packages/cli/src/types.ts` | Add corresponding fields to `ResolvedConfig` (line ~1121 area) | +3 |
| `packages/cli/src/cli/run.ts` | Replace `new CamofoxBrowserMcpAdapter(...)` with `makeBrowserAdapter(resolved)` | +1 / -1 |
| `packages/cli/src/cli/replay.ts` | Same | +1 / -1 |
| `packages/cli/src/cli/scope.ts` | Same | +1 / -1 |
| `packages/cli/src/cli/doctor.ts` | Same; print resolved transport in doctor output | +6 / -1 |
| `packages/cli/src/cli/main.ts` | Add `--browser-transport`, `--browser-mcp-auth-key` flag wiring | +6 |
| `packages/cli/src/cli/init.ts` | Add prompts for `browserTransport` and (if stdio) `browserMcpStdio.command` | +20 |
| `packages/cli/src/ops/retest.ts` | Same factory call | +1 / -1 |

### 11.2 Files created

| File | Reason |
|---|---|
| `packages/cli/src/adapters/browser-mcp.shape.test.ts` | Snapshot tests for each method's `callTool` argument shape |
| `packages/cli/src/adapters/browser-mcp-stdio.test.ts` | Stdio-transport-specific unit tests (subprocess respawn on error, `dispose()` cleanup) |
| `packages/cli/src/adapters/browser-mcp.integration.test.ts` | Live integration tests, `RUN_INTEGRATION=1`-gated |
| `docs/migrations/v49-browser-mcp.md` | User-facing migration guide |

### 11.3 Files NOT touched (verify)

- `packages/cli/src/adapters/browser-mcp-snapshot.ts` — transport-agnostic. Untouched.
- `packages/cli/src/discovery/dom-walker.ts`, `discovery/crawler.ts`, `phases/execute.ts`, `phases/click-runner.ts`, `repro/replay.ts`, `repro/action-log.ts` — all consume the adapter via the `BrowserMcpAdapter` interface. Type unchanged → no edits.
- `/root/camofox-mcp/**` — no changes. V49 does not modify the MCP server.

---

## 12. Task breakdown

| # | Task | Files | Assignee | Deps | Done when |
|---|---|---|---|---|---|
| 1 | Add `browserTransport`, `browserMcpAuthKey`, `browserMcpStdio` to `ConfigSchema` + `ResolvedConfig` | `config.ts`, `types.ts` | @coder | none | Zod schema parses new fields; tsc clean |
| 2 | Implement new `CamofoxBrowserMcpAdapter` with SDK Client (mcp-http path) | `browser-mcp.ts` | @coder | 1 | Class compiles; private `tool<T>()` dispatcher implemented |
| 3 | Implement stdio transport branch in the new adapter | `browser-mcp.ts` | @coder | 2 | `mode:'stdio'` constructs `StdioClientTransport`; `dispose()` closes subprocess |
| 4 | Rename old class to `CamofoxBrowserHttpAdapter`; add deprecation warning | `browser-mcp.ts` | @coder | 2 | Old class exported under new name; deprecation `console.warn` fires |
| 5 | Add `makeBrowserAdapter` factory | `browser-mcp.ts` | @coder | 2,3,4 | Factory returns correct class per `browserTransport` value |
| 6 | Wire factory into all 6 construction sites | `cli/run.ts`, `cli/replay.ts`, `cli/scope.ts`, `cli/doctor.ts`, `cli/init.ts`, `ops/retest.ts` | @coder | 5 | All sites call `makeBrowserAdapter(...)`; no direct `new` of either class |
| 7 | Replace `fetch` mocks in unit tests with SDK Client mocks | `browser-mcp.test.ts` | @coder | 2 | Existing 14 tests pass against new adapter |
| 8 | Add shape-snapshot tests | `browser-mcp.shape.test.ts` (new) | @coder | 2 | One snapshot per adapter method; all pass |
| 9 | Add stdio-specific tests (respawn-on-error, dispose-cleanup) | `browser-mcp-stdio.test.ts` (new) | @coder | 3 | Subprocess kill triggers reconnect on next call |
| 10 | Add live integration test, `RUN_INTEGRATION=1`-gated | `browser-mcp.integration.test.ts` (new) | @qa | 3 | Integration test passes when run against live camofox-mcp |
| 11 | Update `bughunter doctor` to print resolved transport | `cli/doctor.ts` | @coder | 5 | Doctor output includes one line `transport: mcp-http \| mcp-stdio \| http-legacy` |
| 12 | Update `bughunter init` prompts | `cli/init.ts` | @coder | 5 | Init writes `browserTransport` field to config |
| 13 | Add CLI flag wiring | `cli/main.ts` | @coder | 5 | `--browser-transport=mcp-stdio` overrides config |
| 14 | Write migration doc | `docs/migrations/v49-browser-mcp.md` (new) | @architect | 5 | Doc covers what/why/how-to-migrate |
| 15 | Aspectv3 smoke regression | (manual) | @qa | 6,7 | Smoke matches v0.48 baseline |

---

## 13. Negative requirements

- Do **not** change the `BrowserMcpAdapter` interface shape. No new methods, no removed methods, no changed signatures. (V49's only sanctioned interface change is the optional new fields on optional methods — none planned.)
- Do **not** delete `CamofoxBrowserHttpAdapter` in V49. Deletion is V50.
- Do **not** add a new dependency. The SDK is already present.
- Do **not** wire `network_fault` / `in_flight_requests` / `init_script` etc. as interface methods. Use the generic `tool<T>()` escape.
- Do **not** strip the `currentTabId` field from the adapter. Behavior depends on it.
- Do **not** change camofox-mcp source. Server-side stays put.
- Do **not** log full request/response bodies at any level — they may include cookies, JWTs, page content. Log only `{tool, ok, latencyMs}`.
- Do **not** add retry logic at the SDK Client layer. The existing per-method retry (e.g. `click` retries once on `element_not_found`) stays at the adapter layer.
- Do **not** auto-detect the transport (no inference from env vars, no probing port 3104). Config is explicit.
- Do **not** import the SDK transports lazily via `await import()`. Both paths import statically; the unused one is tree-shaken at build time (or just present — both are <50 KB).
- Do **not** change error message strings emitted to users. The SDK's error text differs from `fetch`'s; map to the existing `BrowserMcpError` messages so log scrapers don't break.
- Do **not** alter the `currentTabId` mutation semantics. `navigate()` mutates it; `openTab()` does not. Same as today.

---

## 14. Definition of Done

- [ ] All acceptance criteria in §10 satisfied.
- [ ] All 15 tasks in §12 completed and verified.
- [ ] `npm test` green in `packages/cli`.
- [ ] `npx tsc --noEmit` clean across the monorepo.
- [ ] `npx eslint . --max-warnings 0` clean.
- [ ] Aspectv3 smoke run on the V49 branch matches v0.48 baseline (visionBaselineTelemetry shape, vision.called, no new skippedReasons).
- [ ] Migration doc reviewed.
- [ ] PR description references this spec by file name.
- [ ] No `console.warn`/`console.error` output during normal-path test runs (deprecation warning fires only on explicit `http-legacy` selection).
- [ ] `bughunter doctor` prints the resolved transport line.

---

## 15. Open questions

1. **Should the legacy `CamofoxBrowserHttpAdapter` be exported from the public package entry, or kept internal?** Recommend export — anyone who built tooling around the v0.48 class name needs a migration path. They can switch to `CamofoxBrowserHttpAdapter` for one minor without rewriting.
2. **Should the SDK Client be wrapped in a project-local `BrowserMcpClient` thin abstraction, or used directly?** Recommend direct use. One layer of indirection is fine; two is yak-shaving. The dispatcher (`tool<T>`) is the abstraction.
3. **Should `makeBrowserAdapter` live in `adapters/browser-mcp.ts` or a new `adapters/factory.ts`?** Recommend co-locate in `browser-mcp.ts` for V49 (one file, one logical unit). If a second adapter type appears (e.g. a Playwright-direct bypass), refactor to `factory.ts` then.
4. **Should `network_fault` etc. be promoted to typed interface methods in V49 or deferred?** Defer. V49 is "swap the transport, keep the surface." Adding interface methods is a separate spec (V50?).
5. **Should we add a `bughunter doctor --check-transport` subcommand that round-trips a `navigate` call and reports timing?** Recommend yes, but as a follow-up. V49 doctor output is read-only — print the configured transport and the `Client.connect()` health.
6. **Does the SDK Client need a request-timeout config?** Yes; default 30 s for non-screenshot calls, 60 s for screenshot. Add `browserMcpRequestTimeoutMs` to config (optional, default applied internally). Edge case to verify against camofox-mcp's own server-side timeouts (currently 60 s for navigate).
7. **Should `mcp-stdio` mode auto-restart camofox-mcp on crash, or surface the error?** V49: surface. Auto-restart is policy that belongs in the test runner, not the adapter. The adapter's `tool<T>()` reports `transport` errors; the runner decides whether to retry the test or abort.

---

## 16. Risks + escape hatches

- **Risk: SDK 1.29.0 has a subtle bug under high concurrency.** Escape: `browserTransport: 'http-legacy'` reverts to the hand-rolled adapter. Documented in the migration guide.
- **Risk: Aspectv3 smoke regresses on the new transport.** Escape: keep V49 default at `'http-legacy'` for one release cycle; flip to `'mcp-http'` in v0.49.1 once smoke is green for 7 consecutive nights. (Decision deferred to PR review.)
- **Risk: stdio subprocess leaks under abnormal exit.** Escape: register a `process.on('SIGINT'/'SIGTERM'/'exit')` hook that calls `adapter.dispose()` for any adapter created in the run. Verified by integration test that asserts no zombie processes after `kill -9` parent.
- **Risk: SDK error messages are too verbose / leak headers.** Escape: error-message sanitizer in the dispatcher (strip `Authorization`, strip Cookie, redact base64 > 100 chars). Tests in §7.1.

---

## 17. Reference — current adapter call sites (read-only)

```
packages/cli/src/adapters/browser-mcp.ts                  (definition)
packages/cli/src/adapters/browser-mcp-error.ts            (error types)
packages/cli/src/adapters/browser-mcp-snapshot.ts         (snapshot parsing — transport-agnostic)
packages/cli/src/cli/run.ts                                (construct on run)
packages/cli/src/cli/replay.ts                             (construct on replay)
packages/cli/src/cli/scope.ts                              (construct for scope analyze)
packages/cli/src/cli/doctor.ts                             (construct for health check)
packages/cli/src/cli/main.ts                               (flag wiring)
packages/cli/src/cli/init.ts                               (config init prompts)
packages/cli/src/ops/retest.ts                             (construct on retest)
packages/cli/src/discovery/crawler.ts                      (consume via interface)
packages/cli/src/discovery/dom-walker.ts                   (consume via interface)
packages/cli/src/discovery/browser-login.ts                (consume via interface)
packages/cli/src/discovery/trigger-resolve.ts              (consume via interface)
packages/cli/src/phases/execute.ts                         (consume via interface)
packages/cli/src/phases/click-runner.ts                    (consume via interface)
packages/cli/src/phases/auth-flow.ts                       (consume via interface)
packages/cli/src/phases/form-reachability-probe.ts         (consume via interface)
packages/cli/src/repro/replay.ts                           (consume via interface)
packages/cli/src/repro/action-log.ts                       (consume via interface)
+ test files mirroring above
```

42 files reference the adapter or the interface. V49 modifies 6 (the construction sites). The other 36 are interface consumers and should compile unchanged — that is the migration safety net.

---

## 18. Snapshot of camofox-mcp tool inventory (as of 2026-04-30)

19 tools registered (verified against `/root/camofox-mcp/src/core/tools.ts` + `/root/camofox-mcp/tests/transport-parity.test.ts`):

```
navigate, snapshot, click, type, scroll, screenshot, evaluate,
list_tabs, close_tab, cookies, set_viewport,
network_fault, clear_network_fault, get_network_fault,
in_flight_requests,
init_script, clear_init_scripts,
set_timezone, clear_timezone
```

`route_fulfill` and `route_fulfill_remove` are **not** in the camofox-mcp tool list as of the spec date — V49 keeps `routeFulfill?` optional and the rejection path is the spec's contract. If/when camofox-mcp adds them, the adapter call is already wired (see §5 row 17) and the optional method becomes always-implemented.
