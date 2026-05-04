# SPEC — v0.50 "WebSocket / SSE detection and fault injection"

**Status:** Draft 1 — ready for `@coder` assignment
**Author:** `@architect` (Opus, ultrathink)
**Date:** 2026-05-02
**Predecessors:** v0.20 (network-fault palette — pattern + camofox-mcp dependency cycle), v0.40 (multi-context — N-tab orchestration), v0.49 (BugHunter-via-MCP transport, Client + StreamableHTTPClientTransport)
**Sibling:** path-to-exhaustive §3.1 ("Browser-platform surface — WebSocket / SSE" line 58 — this spec promotes that bullet to in-scope)
**External dep risk:** camofox-mcp v0.6 has zero realtime tooling. V50.1 ships without that dep by reading CDP events the existing parallel-Playwright session already captures. V50.2 requires camofox-mcp ≥ v0.7 with three new tools (§ 6 + § 11). Under no circumstances does V50 add a fourth browser. Both phases use the existing Playwright-Firefox (camofox) and parallel-Playwright-Chromium (CDP) sessions.

This spec adds detection of real-time-protocol (WebSocket and SSE) bugs to BugHunter. v0.20 deliberately deferred WS/SSE specifics; v0.40 deliberately deferred WS coordination; this spec covers them. Two phases: **V50.1 (read-side) — passive classification of in-flight realtime traffic** during normal walks; **V50.2 (active fault injection) — force-disconnect, drop-frame, out-of-order replay, slow-consumer, malformed-frame** — bounded by the same opt-in / collapse / per-test-cap guarantees v0.20 ships.

---

## 1. Problem statement

Vibe-coded SPAs ship realtime UIs with three predictable failure shapes that BugHunter today walks past silently. (1) **Auth-on-upgrade bugs** — the HTTP page is gated behind a session cookie, but the WebSocket upgrade request is opened from JS that drops the auth header and the server accepts it. Anonymous WS connections subscribe to topics meant for authenticated users. Real-world examples: Notion-clones, Cursor-clones, multiplayer canvases, "live cursors" demos — the CRUD endpoints are guarded but the realtime channel isn't. (2) **Reconnect / lifecycle bugs** — disconnect happens (mobile network blip, tab backgrounded, server restart), the client either spinners forever, drops messages silently, or storms the server with reconnect attempts that never back off. SSE in particular ships with a built-in `Last-Event-ID` resume protocol that vibe-coded backends almost never honor; the client thinks it caught up, the server starts from the beginning. (3) **Message-ordering / concurrency bugs** — two updates arrive out of order, the optimistic UI applies them in receipt order rather than authoritative order, state diverges from the server. Slow-consumer backpressure is the WebTransport-flavored sibling: a slow client falls behind, the server drops frames or buffers them past memory limits, the client never realizes it has stale state.

These bugs cost trust (someone else's cursor on your screen), correctness (wrong totals on dashboards), and money (websocket-storm DDoS-ing the user's own backend). BugHunter today reports zero of them — the closest existing detector is v0.20's `network_fault_unhandled`, which only reports because we forced the *fetch* to fail; the WebSocket survives v0.20's offline mode (Playwright Firefox's `BrowserContext.setOffline(true)` does NOT close existing WS connections — it blocks new outgoing TCP only). This spec promotes WS/SSE from "out of scope" (path-to-exhaustive §3.1, line 58) to in-scope.

---

## 2. Scope: in / out

### 2.1 In scope (V50.1 + V50.2 combined)

- **Detection surface (§ 3):** CDP `Network.webSocketCreated`, `webSocketWillSendHandshakeRequest`, `webSocketHandshakeResponseReceived`, `webSocketFrameSent`, `webSocketFrameReceived`, `webSocketFrameError`, `webSocketClosed`, `eventSourceMessageReceived`. Read off the existing parallel-Playwright Chromium session (`adapters/cdp-session.ts`).
- **Eight new BugKinds** (§ 4) split across shared / WS-only / SSE-only.
- **V50.1 read-side runner:** a passive observer that hangs off the existing CDP session, accumulates realtime events per `actionWindowId`, and calls four passive detectors at classify time. No new browser endpoints, no fault injection — ships in the same PR as the new BugKinds.
- **V50.2 active runner:** a `RealtimeFaultRunner` that mirrors v0.20's `NetworkFaultRunner` shape — opt-in, mutating-action-bound, same-shape collapsed, hard-capped wall-clock budget, capability-gated at validate phase.
- **Six-variant fault palette** (§ 5): `force_close`, `drop_frame_every_n`, `replay_out_of_order`, `slow_consumer`, `inject_malformed_frame`, `sse_inject_id_gap`.
- **Cluster signatures** for all eight kinds (variant included for the four kinds that have variants).
- **Telemetry** on `summary.json.realtime` (V50.1) and `summary.json.realtimeFaults` (V50.2).
- **CLI flags:** `--realtime-detect` / `--no-realtime-detect` (default `on`, V50.1 zero-cost), `--realtime-faults` / `--no-realtime-faults` (default `off`, V50.2 opt-in like v0.20).
- **One synthetic fixture** `fixtures/realtime-bad/` (Bun + `ws` server + minimal SPA) exercising all eight kinds. Acceptance gate.

### 2.2 Out of scope (deferred — punt with reason)

- **gRPC, RTC (WebRTC peer connections), QUIC, WebTransport** — different transports, different test fixtures, different bug shapes. Punted explicitly to V51+ if a real target ever needs them. WebRTC ICE / peer-disconnect lives at path-to-exhaustive §3.1 line 57 and stays there.
- **HTTP/2 server push** — deprecated in Chromium, niche elsewhere. Not WS/SSE.
- **WebSocket-over-HTTP/2 (RFC 8441)** — Playwright doesn't expose differentiated CDP events for it; treat identically to WS/1.1 for V50. Document as EC-7.
- **Long-polling endpoints that aren't SSE** — they pattern-match SSE bugs (resume on disconnect, etc.) but are application-shaped, not protocol-shaped. v0.20's existing fault palette covers their failure modes.
- **Server-side realtime correctness** — V50 is a UI-walker, same as the rest of BugHunter. We test what the *client* does with realtime input. Authoritative ordering, idempotency, exactly-once delivery on the server are not BugHunter's job.
- **Realtime cross-tab convergence** — N-tab WebSocket coordination is v0.40 territory in spirit; the cleanest expression is an N=2 case of `multi_context_state_divergence` triggered by a WS-driven mutation. V50 does not extend the multi-context runner. If telemetry from V50 shows the gap is real, file V51.
- **Recording WS frames into HAR** — HAR 1.2 has no canonical WS frame shape. Some tools (Charles, Chrome DevTools) emit `_webSocketMessages` extensions; standardizing is out of scope. V50 logs WS frames into a sibling artifact `realtime/<actionWindowId>.ndjson`, not the HAR.
- **WebSocket per-message-deflate / compression bugs** — possible bug class, niche, narrow detection. Punt.
- **JWT-on-WS rotation** — partial overlap with v0.18 JWT login verify. V50.1 emits `realtime_connection_unauthenticated` if the WS lacks any auth on upgrade; deeper "your JWT was valid but expired-mid-stream and the server kept honoring it" needs v0.18-style invariants. Out of scope for V50.
- **Mid-stream injection of arbitrary network faults during an open WS** (combine V20 + V50) — combinatorial blow-up; defer to v0.51 if telemetry shows the gap.

### 2.3 WS-specific vs SSE-specific vs shared (taxonomy preview)

| BugKind | WS | SSE | Shared |
|---|---|---|---|
| `realtime_connection_unauthenticated` | ✓ | ✓ | shared |
| `realtime_disconnect_no_reconnect` | ✓ | ✓ | shared |
| `realtime_pii_in_broadcast` | ✓ | ✓ | shared |
| `websocket_mixed_content` | ✓ |  | WS-only |
| `websocket_message_unhandled_exception` | ✓ |  | WS-only |
| `websocket_out_of_order_state_corruption` | ✓ |  | WS-only (V50.2) |
| `websocket_backpressure_no_drop` | ✓ |  | WS-only (V50.2) |
| `sse_no_lastEventId_resume` |  | ✓ | SSE-only (V50.2) |
| `sse_infinite_reconnect_storm` |  | ✓ | SSE-only |

(Nine kinds named — `websocket_backpressure_no_drop` is folded into `websocket_message_unhandled_exception` if implementation cost is too high; see § 4.4 open question.)

---

## 3. Detection surface

### 3.1 Primary: CDP Network domain on the parallel Chromium session

The existing parallel-Playwright Chromium session (introduced for V8/V24/V36 perf observation, file `adapters/cdp-session.ts`) already speaks CDP and already accumulates `Network.requestWillBeSent` / `responseReceived` / `loadingFinished`. CDP exposes seven events that V50.1 reads:

| CDP event | Captures | Used for |
|---|---|---|
| `Network.webSocketCreated` | `requestId`, `url`, optional `initiator` | Discovery: a WS exists. Tag on `RealtimeContext`. |
| `Network.webSocketWillSendHandshakeRequest` | `requestId`, `request.headers` | Auth audit: was `Authorization` / `Cookie` / `Sec-WebSocket-Protocol` (subprotocol-as-token pattern) present on upgrade? |
| `Network.webSocketHandshakeResponseReceived` | `requestId`, `response.status`, `response.headers` | Confirm 101 Switching Protocols; capture set-cookie / sec-websocket-extensions. |
| `Network.webSocketFrameSent` | `requestId`, `timestamp`, `response.payloadData`, `response.opcode`, `response.mask` | Outbound frame log (truncated to 4 KiB; full body to artifact only). |
| `Network.webSocketFrameReceived` | `requestId`, `timestamp`, `response.payloadData`, `response.opcode` | Inbound frame log; body scanned for PII signals. |
| `Network.webSocketFrameError` | `requestId`, `errorMessage` | Frame-level parse failure → flag. |
| `Network.webSocketClosed` | `requestId`, `timestamp` | Close transitions; counts open→close cycles per action window. |
| `Network.eventSourceMessageReceived` | `requestId`, `timestamp`, `eventName`, `eventId`, `data` | SSE message log; `eventId` populates `Last-Event-ID` audit. |

CDP uses one `requestId` per WS connection and emits `webSocketFrameSent` / `webSocketFrameReceived` per frame on that ID. SSE uses the connection's request ID and emits `eventSourceMessageReceived` per `data:`-block — the response itself is the long-lived `text/event-stream` HTTP response already captured by the existing HAR pipeline. The two surfaces overlap nicely.

### 3.2 Secondary: HAR upgrade-request as discovery fallback

Even without CDP enabled, the HAR pipeline already captures the protocol-upgrade GET (`Connection: Upgrade`, `Upgrade: websocket`, `Sec-WebSocket-Key`, response `101 Switching Protocols`). This is enough to detect WS *existence*, the upgrade URL, and presence of auth headers. SSE shows up as a normal `GET` with response `Content-Type: text/event-stream`. **V50.1 detection of `realtime_connection_unauthenticated` and `realtime_disconnect_no_reconnect` works off HAR alone** — we want the runner to fire on builds where CDP is disabled (e.g. `--no-perf`), not just when CDP happens to be on.

### 3.3 Tertiary: bundle-source heuristic (rejected for V50.1)

A regex over the bundled JS for `new WebSocket(`, `new EventSource(` was considered as a discovery aid. **Rejected** for V50.1 because: bundles are minified (`new t(`), source-maps may not be served, and CDP + HAR already give us the truth — what actually opened, not what *might* open. Static heuristics would only confirm what dynamic capture already proves. Reserve as a v0.51 enhancement if telemetry shows realtime traffic that opens conditionally and our walks miss the trigger.

### 3.4 What exits the walk and what doesn't

The runner is bound to `actionWindowId` — the same scoping unit `cdp-session.ts` and `har-writer.ts` use today. Frames before the action's window-open and after window-close + `asyncMaxWaitMs` are dropped. The WebSocket connection itself MAY persist across action windows (a chat app keeps one WS for the whole session); detectors that need long-lived state (e.g. "a single WS opens, never closes, but reconnects 50 times" — `sse_infinite_reconnect_storm`'s WS sibling) consult a per-tab `RealtimeConnectionLog` that persists for the lifetime of the tab, not just the window. Per-tab log is wiped in `withTab`'s `finally`, same as everything else.

---

## 4. BugKinds proposed

Eight (or nine — § 4.4 open question) new `BugKind` variants. Naming follows existing snake_case convention; shared kinds use the `realtime_` prefix, WS-only the `websocket_` prefix, SSE-only the `sse_` prefix. Severities are calibrated against the existing slot table — `realtime_connection_unauthenticated` is `critical` (auth bypass on a parallel channel), `_pii_in_broadcast` is `critical` (data exfil), the rest are `major` or `minor`.

### 4.1 Shared (3)

| Kind | Trigger condition | Detector site | Telemetry counter | Severity |
|---|---|---|---|---|
| `realtime_connection_unauthenticated` | The handshake request (HAR upgrade GET, or CDP `webSocketWillSendHandshakeRequest` / SSE upgrade request) carries NO `Cookie` header AND NO `Authorization` header AND NO `Sec-WebSocket-Protocol` header that matches a known token-as-subprotocol pattern (regex `(jwt\|token\|bearer)` case-insensitive), AND the page that opened the connection was reached after a successful login (role !== anonymous). | `classify/realtime-auth.ts` | `realtime.authMissing` | `critical` |
| `realtime_disconnect_no_reconnect` | A WS connection closed (CDP `webSocketClosed`) OR an SSE connection terminated mid-stream (HAR shows the response ended without the SPA navigating away). After `asyncMaxWaitMs`, no new WS/SSE handshake to the same origin AND the UI shows no offline / stale-data indicator (no `aria-busy`, no `[role="alert"]`, no `[data-testid*="offline"]`, no recognized error text). | `classify/realtime-reconnect.ts` | `realtime.reconnectMissing` | `major` |
| `realtime_pii_in_broadcast` | An inbound WS frame body OR SSE `data` field contains PII shaped tokens not associated with the current logged-in user. PII regex set (mirrored from `lib/pii-redactor.ts` if present, else MVP set: email, US-style phone, SSN, credit-card-Luhn, JWT-shape, AWS access key, GitHub PAT). Fires when ≥1 token does NOT appear anywhere in the pre-state DOM (the user wasn't shown this PII through the normal UI path). | `classify/realtime-pii.ts` | `realtime.piiBroadcast` | `critical` |

### 4.2 WS-only (3 — + 1 V50.2-deferred)

| Kind | Trigger condition | Detector site | Telemetry counter | Severity |
|---|---|---|---|---|
| `websocket_mixed_content` | The page loaded over `https://`. The WS upgrade URL is `ws://` (not `wss://`). Browsers block this in production, but vibe-coded dev configs often disable mixed-content blocking via `--allow-running-insecure-content` or `dev` reverse-proxies; the bug is shipped to prod when dev defaults leak. | `classify/realtime-mixed-content.ts` | `realtime.mixedContent` | `major` |
| `websocket_message_unhandled_exception` | An inbound WS frame is delivered, and within `asyncMaxWaitMs` the page emits a `console.error` whose stack frame includes `WebSocket.onmessage` OR a recognized framework dispatcher (`Pusher.connection.dispatcher`, `socket.io.client.onevent`, etc.) AND no UI error state appears. Reuses the existing `console.ts` classifier — V50 only adds the WS-attribution heuristic. | `classify/realtime-message-exception.ts` (thin wrapper over `classify/console.ts`) | `realtime.frameException` | `major` |
| `websocket_out_of_order_state_corruption` (V50.2 only) | Active fault: replay frames out of order (`replay_out_of_order` palette). Detector observes pre-fault DOM state, captures intermediate snapshot at +200 ms, post-state at `asyncMaxWaitMs`. Fires when post-state's reconcilable field-set differs from server-authoritative-order final state computed from frame log AND no error UI. | `classify/realtime-out-of-order.ts` | `realtime.outOfOrderCorruption` | `critical` |
| `websocket_backpressure_no_drop` (V50.2, conditional — § 4.4) | Active fault: `slow_consumer` palette (delay client read of frames by N ms). Detector observes whether the client buffers unboundedly (memory growth observed via the existing v0.8 `memory-leak.ts` JS-heap probe), drops frames silently (no `console.warn`), or surfaces a backpressure UI. Bug if memory grows >`backpressureMemoryThresholdMb` AND no UI indicator AND no console signal. | `classify/realtime-backpressure.ts` | `realtime.backpressureNoDrop` | `major` |

### 4.3 SSE-only (2)

| Kind | Trigger condition | Detector site | Telemetry counter | Severity |
|---|---|---|---|---|
| `sse_no_lastEventId_resume` (V50.2) | Active fault: force-close the SSE stream after `eventId` ≥ 5. Detector observes the next SSE handshake. Bug if the new handshake's `Last-Event-ID` request header is absent OR set to something other than the last successfully-received `eventId`. (The `EventSource` API does this automatically, but applications that wrap a custom `fetch`-based SSE client almost always forget.) | `classify/sse-resume.ts` | `realtime.sseResumeMissing` | `major` |
| `sse_infinite_reconnect_storm` | Passive: per-tab `RealtimeConnectionLog` records every SSE handshake. Bug if >`reconnectStormThreshold` (default 10) handshakes to the same SSE URL within 30 s wall-clock, AND each successive handshake's gap monotonically does NOT increase (i.e. no exponential backoff observed; stall variance < 1.5×). | `classify/sse-reconnect-storm.ts` | `realtime.sseReconnectStorm` | `major` |

### 4.4 Open question on `websocket_backpressure_no_drop`

Backpressure detection is the most-likely-to-false-positive kind. JS heap growth is noisy, framework abstractions buffer in opaque places (Apollo, Phoenix), and "no drop UI" can be normal for low-volume apps. **If the V50.2 implementation budget is tight, ship without this kind and reopen in v0.51.** The other eight kinds carry V50's value; this one is value-marginal and detector-expensive. Decision deferred to the V50.2 implementation review. Spec written assuming it ships; § 13 task list flags it as cuttable.

---

## 5. Mutation palette additions (V50.2)

Mirrors v0.20's `NetworkFaultSpec` discriminated-union shape. Six variants. Six is the right number — fewer than v0.20's eight because realtime faults are individually higher-cost (each forces a full reconnect cycle to clean up).

```ts
export type RealtimeFaultSpec =
  | { kind: 'force_close'; closeCode: 1000 | 1001 | 1006 | 1011 | 1012; closeReason?: string }
  | { kind: 'drop_frame_every_n'; n: number /* default 2 — drop every 2nd inbound frame */; direction: 'inbound' | 'outbound' | 'both' }
  | { kind: 'replay_out_of_order'; windowSize: number /* default 3 — buffer 3 inbound frames then deliver in reverse */ }
  | { kind: 'slow_consumer'; readDelayMs: number /* default 500 — hold each inbound frame for N ms before delivering to JS */ }
  | { kind: 'inject_malformed_frame'; mode: 'truncated_json' | 'wrong_opcode' | 'control_frame_with_payload' }
  | { kind: 'sse_inject_id_gap'; gapAfterEventCount: number /* default 5 — close stream cleanly after N events; client must resume from Last-Event-ID */ };
```

Variant-by-variant:

| Variant | On-wire effect | Targets BugKind(s) | Default cap |
|---|---|---|---|
| `force_close` | Close the WS at the proxy with the given code. 1006 (abnormal closure) is the most common real-world signal; 1011 (server error) tests "server crashed mid-stream" handling. SSE: close the response stream uncleanly. | `realtime_disconnect_no_reconnect`, `sse_no_lastEventId_resume` | `perTestMaxMs` cap = `min(asyncMaxWaitMs * 2, 60_000)` |
| `drop_frame_every_n` | Stateful: counter on the proxy; drops inbound frame every Nth arrival from server, OR outbound every Nth from client, OR both. Default N=2. | `websocket_message_unhandled_exception` (subset), `websocket_backpressure_no_drop` (when `direction: outbound`) | `perTestMaxMs` cap |
| `replay_out_of_order` | Buffer `windowSize` inbound frames; deliver in reverse order. Resets buffer on close. | `websocket_out_of_order_state_corruption` | `perTestMaxMs` cap |
| `slow_consumer` | Hold each inbound frame for `readDelayMs` before forwarding to client. 500 ms default; 5000 ms exposes hard backpressure. | `websocket_backpressure_no_drop` | extended cap = `min(asyncMaxWaitMs * 3, 90_000)` (slow consumer needs more wall-clock to expose the bug) |
| `inject_malformed_frame` | Modes: truncate JSON mid-string (parse-error path); rewrite frame opcode (binary-vs-text mismatch); inject a control frame (ping/pong) carrying a payload (RFC 6455 violation). | `websocket_message_unhandled_exception` | `perTestMaxMs` cap |
| `sse_inject_id_gap` | Cleanly close the SSE response after `gapAfterEventCount` events. The browser will reconnect with `Last-Event-ID: <last>` automatically. The proxy then resumes from event `gapAfterEventCount + 5` (skipping 5 events) — the client must show a "missed events" UI or refetch. Custom SSE clients that don't honor `Last-Event-ID` resume from event 0. | `sse_no_lastEventId_resume` | `perTestMaxMs` cap |

### 5.1 Default fault palette

```ts
const DEFAULT_REALTIME_FAULT_PALETTE: RealtimeFaultSpec[] = [
  { kind: 'force_close', closeCode: 1006 },                 // common real-world disconnect
  { kind: 'drop_frame_every_n', n: 2, direction: 'inbound' }, // ordering tests
  { kind: 'replay_out_of_order', windowSize: 3 },           // ordering corruption
  { kind: 'inject_malformed_frame', mode: 'truncated_json' }, // parser robustness
  { kind: 'sse_inject_id_gap', gapAfterEventCount: 5 },     // SSE resume
];
```

`slow_consumer` and the two non-default `force_close` codes (1011, 1012) and the other `inject_malformed_frame` modes (`wrong_opcode`, `control_frame_with_payload`) are NOT in the default set — they overlap with the chosen-default variants and add cost. Users opt them in via `realtimeFaults.variants`.

### 5.2 Mutation-system anchor: extends the v0.20 model, does NOT fork it

The runner is a new file (`security/realtime-fault-runner.ts`) but reuses every cost-control primitive v0.20 introduced:

- **Same-shape collapse** — one realtime-fault test per (role, collapsed-action-signature, fault-variant). 50 chat-message-send buttons sharing a signature = 1 fault test per variant per role.
- **Per-action wall-clock cap** — see table above; `slow_consumer` gets 3× normal, others 2× (unlike v0.20's flat 1.5×, because realtime faults need a full reconnect-and-observe cycle).
- **Bounded fault matrix** — `realtimeFaults.maxFaultTests` (default 100, half v0.20's 200; realtime faults are slower).
- **Per-test cleanup mandatory in `finally`** — `clearRealtimeFault(tabId)` always called; fresh tab via `withTab` for the next test.
- **Capability check at validate phase** — like v0.20: probe `applyRealtimeFault({kind:'force_close',closeCode:1006})` against a throwaway tab; if it fails with `tool_not_available`, abort with explicit error pointing to § 6 / § 11.

---

## 6. Camofox / BrowserMCP requirements

V50.1 needs **zero** new camofox-mcp tooling. The existing parallel-Playwright Chromium CDP session in `adapters/cdp-session.ts` already captures the WS / SSE events V50.1 needs. V50.1 ships behind a config flag (`realtime.detect = true` default) and reads off the same CDP-event pipeline V8/V24 use; the new code is detector-only.

V50.2 needs three new tools on camofox-mcp ≥ v0.7. (Pattern mirrors v0.20: BugHunter spec depends on a sibling camofox-mcp PR.)

### 6.1 Required camofox-mcp tools (V50.2)

```
realtime_observe — start a tap on the tab's CDP session that records WS + SSE events
                   into a per-tab buffer. Idempotent.
  Input:  { tabId }
  Output: { ok: true, observerId: string }

realtime_drain — return and clear the per-tab buffer.
  Input:  { tabId }
  Output: { ok: true, frames: RealtimeFrame[] }
    where RealtimeFrame =
      | { type: 'ws_open'; url: string; ts: number; requestId: string; requestHeaders: Record<string,string> }
      | { type: 'ws_handshake_response'; requestId: string; status: number; responseHeaders: Record<string,string>; ts: number }
      | { type: 'ws_frame_sent'; requestId: string; ts: number; opcode: number; payload: string /* base64 if binary */ }
      | { type: 'ws_frame_received'; requestId: string; ts: number; opcode: number; payload: string }
      | { type: 'ws_closed'; requestId: string; ts: number; code?: number; reason?: string }
      | { type: 'sse_message'; requestId: string; ts: number; eventName?: string; eventId?: string; data: string }

realtime_fault — install a fault on a tab. Idempotent (replaces previous spec).
                 Implemented via Playwright's BrowserContext.routeWebSocket()
                 (Playwright ≥ 1.48; supported on Firefox / Chromium / WebKit).
                 SSE faults installed via Playwright's existing page.route() with
                 streaming response handling (a thin proxy over the upstream stream).
  Input:  { tabId, fault: RealtimeFaultSpec }
  Output: { ok: true, applied: boolean, reason?: string }

clear_realtime_fault — clear any installed realtime fault on a tab. Idempotent.
  Input:  { tabId }
  Output: { ok: true }
```

`realtime_observe` and `realtime_drain` are technically usable by V50.1 too — but V50.1 ships off the existing parallel-Chromium CDP path to avoid blocking on camofox-mcp v0.7. If camofox-mcp lands the observer tool first, V50.1 gets a free upgrade (one source of truth instead of two), but the spec does not require it.

### 6.2 Underlying server endpoints (camofox-browser at port 9377)

```
POST /tabs/:tabId/realtime/observe       — body: {}; response: { observerId }
GET  /tabs/:tabId/realtime/frames        — response: { frames: RealtimeFrame[] } (drains)
POST /tabs/:tabId/realtime/fault         — body: { fault: RealtimeFaultSpec }
DELETE /tabs/:tabId/realtime/fault
```

Implementation in `/root/.openclaw/extensions/camofox-browser/server.js` uses Playwright's:

- `BrowserContext.routeWebSocket(url, handler)` for WS faults — handler receives a `WebSocketRoute` that exposes `.send()`, `.receive()`, `.close()`, and frame-level interception. Stable on Firefox per Playwright 1.48 changelog. **CRITICAL VERIFICATION ITEM:** confirm Camoufox's Firefox fork supports `routeWebSocket`. If it does not, V50.2 fault injection routes through an alternative — see § 6.4 fallback.
- `Page.routeFromHAR()` is irrelevant here; we are NOT pre-recording.
- For SSE, `BrowserContext.route(url)` already supports streamed-response interception via `route.fulfill({ body: new ReadableStream(...) })`. We proxy upstream and modulate the stream per `RealtimeFaultSpec`.

### 6.3 BugHunter validation behaviour when camofox is too old

In `phases/validate.ts` (mirror v0.20 § 6.3):

```
if (config.realtimeFaults?.enabled === true) {
  - Probe the camofox adapter: applyRealtimeFault({ kind: 'force_close', closeCode: 1006 })
    against a throwaway tab navigated to a known-WS test target (validate phase
    spawns a tiny http server on a random port for this; same trick V20 uses).
  - If applyRealtimeFault is undefined OR returns { applied: false, reason: 'tool_not_available' }:
      Abort with: "realtimeFaults.enabled = true but camofox-mcp v0.6 does not
      support realtime fault injection. Required: camofox-mcp ≥ v0.7 with the
      realtime_fault tool. See docs/specs/V50_WEBSOCKET_SSE.md § 6 + § 11."
  - Do NOT silently skip.
}
```

V50.1 has no equivalent gate — it works on every supported camofox + Playwright combo.

### 6.4 Fallback path if Camoufox lacks `routeWebSocket` (rejected for V50.2 spec gate, escape hatch only)

If Camoufox's Firefox fork does not surface `BrowserContext.routeWebSocket`, V50.2 fault injection cannot ship behind camofox. Two escape hatches, in order of preference:

1. **Run V50.2 against the existing parallel-Chromium session** (the one V8/V24 use for perf observation). Playwright Chromium has rock-solid `routeWebSocket`. Tradeoff: faults are injected against Chromium, while UI observation happens on camofox-Firefox. Acceptable because BugHunter already runs both browsers per session — they're for different concerns. V50.2 detection happens off the Chromium-CDP frame log AND the camofox DOM observation; cross-browser isn't a clean fit.
2. **Service-worker fault shim** — same approach v0.20 considered and rejected. Same rejection reasons here. Listed only for completeness.

**Decision:** the spec assumes Camoufox supports `routeWebSocket` (Playwright 1.48+, Firefox is named in the changelog). The first fallback is documented as an escape-hatch in § 15. If validation against Camoufox fails, V50.2 ships gated and the implementer files a Camoufox-or-camofox-mcp PR.

---

## 7. Test strategy

### 7.1 New synthetic fixture: `fixtures/realtime-bad/`

Bun + `ws` (npm) backend, plus a single-page React frontend served from `/`. One fixture, eight planted bugs (one per BugKind; nine if `websocket_backpressure_no_drop` ships). Pattern follows `fixtures/network-faults-bad/` exactly.

**Routes (each plants one bug):**

| Route | Planted bug | BugKind targeted |
|---|---|---|
| `/auth-leak` | WS opens with no `Cookie`/`Authorization` header from a logged-in user's page | `realtime_connection_unauthenticated` |
| `/no-reconnect` | WS closes after 2 s; client `onclose` does nothing | `realtime_disconnect_no_reconnect` |
| `/pii-broadcast` | WS broadcasts every connected user's email on each `users.changed` event | `realtime_pii_in_broadcast` |
| `/mixed` | Page is `https://`, WS URL is hardcoded `ws://` | `websocket_mixed_content` |
| `/onmessage-throw` | Inbound frame triggers `JSON.parse(undefined)` in handler | `websocket_message_unhandled_exception` |
| `/out-of-order` (V50.2) | Server emits authoritative order; client applies in receipt order | `websocket_out_of_order_state_corruption` |
| `/backpressure` (V50.2, conditional) | Client buffers all frames in unbounded array, no drop, no UI | `websocket_backpressure_no_drop` |
| `/sse-resume-broken` (V50.2) | Custom SSE client via `fetch` + `getReader().read()`; ignores `Last-Event-ID` on reconnect | `sse_no_lastEventId_resume` |
| `/sse-storm` | SSE endpoint returns 500; client reconnects in tight `while(true)` with no backoff | `sse_infinite_reconnect_storm` |

Smoke run from `tests/integration/realtime-smoke.test.ts`:

```bash
# V50.1 only (default)
node packages/cli/dist/cli/main.js run --target file://$PWD/fixtures/realtime-bad

# V50.2 (requires camofox-mcp v0.7+)
node packages/cli/dist/cli/main.js run --target ... --realtime-faults
```

**Acceptance:** ≥1 finding per BugKind, with the correct `realtimeContext` field populated and `proof` matching the planted shape (§ 10).

### 7.2 Calibration corpus (V44 anchor)

Add `realtime-bad` to V44's calibration corpus (`fixtures/calibration/realtime-bad/` or symlink). V44's coverage report should track: every V50 BugKind has ≥1 calibration fixture; the `realtime/` artifact directory contains a non-empty NDJSON frame log per fault test. Tracked in V44's `coverage.json` under `kindsCovered.realtime`.

### 7.3 Negative smoke

Run V50.1 against `Aspectv3` (no realtime traffic — the app is sync-only): expect zero `realtime_*` findings. If any fire, the detector has a false positive and the `Aspectv3` finding is the regression test for the next iteration.

Run V50.1 against TraiderJo (uses SSE for live PnL): expect SSE handshake captured, expect `sse_no_lastEventId_resume` not to fire (TraiderJo uses native `EventSource`, which honors `Last-Event-ID`), expect `sse_infinite_reconnect_storm` not to fire under healthy network. If V50.1 fires a `realtime_*` finding on TraiderJo, manual triage decides keep/suppress/improve-detector.

### 7.4 Unit-level testing

Mirror v0.20's pattern:

- `security/realtime-fault-palette.test.ts` — variant table, default subset, denylist filter.
- `classify/realtime-auth.test.ts`, `classify/realtime-reconnect.test.ts`, `classify/realtime-pii.test.ts`, `classify/realtime-mixed-content.test.ts`, `classify/realtime-message-exception.test.ts`, `classify/sse-reconnect-storm.test.ts` — synthetic frame fixtures.
- V50.2 detectors: `classify/realtime-out-of-order.test.ts`, `classify/realtime-backpressure.test.ts`, `classify/sse-resume.test.ts`.
- `cluster/signature.test.ts` — eight new cases.
- `phases/validate.test.ts` — capability probe + abort path for V50.2.
- `phases/execute.test.ts` — `clearRealtimeFault` called in `finally` even if action throws.

---

## 8. Failure modes / non-goals

### 8.1 Failure modes (documented; not bugs)

- **Silent SW interception of WS upgrade.** ServiceWorkers cannot intercept WS upgrades (RFC 6455 + browser policy), so unlike v0.20's EC-17, V50 does not have a SW-cache observability gap on the WS side. SSE responses CAN be SW-cached; same EC-17 mitigation applies.
- **App opens WS lazily (only after a specific user action 5 levels deep in a wizard).** V50 only sees what the walk reaches. Coverage limitation, not bug.
- **JWT-as-first-frame patterns.** Some apps open the WS unauthenticated, then immediately send a `{ type: 'auth', token: '...' }` frame. V50.1 sees no auth header on upgrade and fires `realtime_connection_unauthenticated` — a false positive on the strict-handshake interpretation. Mitigation: detector inspects the first 5 outbound frames; if any contains a JWT-shape token (`eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+`), suppress and emit a `secondaryObservations` note. Configurable: `realtime.suppressOnFirstFrameAuth: boolean` (default `true`).
- **Bun / Deno test backends emitting frames in a different timezone format.** Frame `ts` is monotonic; ordering detectors don't care about wall-clock.

### 8.2 Non-goals

- BugHunter does not test the realtime SERVER. We do not assert the server is honoring `Last-Event-ID` correctly — we assert the *client* sends it. If the server doesn't honor it, that's a server bug a hand-rolled e2e test should catch.
- We do not assert message ordering correctness against an authoritative oracle (we have no oracle for "what should the server have sent in what order"). `websocket_out_of_order_state_corruption` requires the active fault path to provide that oracle synthetically: WE replay frames out-of-order, so WE know the correct order.
- We do not reverse-engineer custom protocols layered over WS (Phoenix, Pusher, Ably, Liveblocks, Yjs binary CRDTs). The protocol-aware detectors stay generic — JSON-shape detection only. Binary-frame WS connections are observed but their payloads aren't interpreted.

---

## 9. Phasing

### 9.1 V50.1 (read-side; ships first)

**Goal:** detect the four passive bug kinds with zero camofox-mcp dependency and zero new browser endpoints. Net cost: detector code + fixture + tests + telemetry. Ships in one PR.

**Scope:**

- Five passive BugKinds: `realtime_connection_unauthenticated`, `realtime_disconnect_no_reconnect`, `realtime_pii_in_broadcast`, `websocket_mixed_content`, `websocket_message_unhandled_exception`, `sse_infinite_reconnect_storm`. (Six. Counted twice above; the table in § 4 is canonical.)
- New observer module: `packages/cli/src/realtime/realtime-observer.ts`. Hooks into the existing `cdp-session.ts` Network domain subscriber; receives the seven WS-shaped CDP events and one SSE event; partitions by `actionWindowId` and per-tab `RealtimeConnectionLog`.
- Six new classifiers under `packages/cli/src/classify/realtime-*.ts` and `classify/sse-*.ts`.
- Telemetry on `summary.json.realtime`.
- CLI flag `--realtime-detect` (default `on` if CDP is enabled; `off` otherwise).
- Fixture `fixtures/realtime-bad/` with the six routes targeting passive kinds.
- Integration smoke `tests/integration/realtime-smoke.test.ts` gated on Bun availability.

**Cost:** ~600 lines runner + classifiers + types; ~400 lines tests; ~250 lines fixture. A `@coder` agent finishes V50.1 in 2-3 task assignments.

**Shippable on its own:** yes. Closes the path-to-exhaustive §3.1 line-58 gap for the passive surface.

### 9.2 V50.2 (active fault injection; ships after camofox-mcp v0.7 + V50.1 baseline)

**Goal:** add the three active-fault BugKinds (and the conditional `websocket_backpressure_no_drop`). Net cost: fault runner + adapter extension + camofox-mcp companion-spec PR.

**Scope:**

- Three (or four) active BugKinds: `websocket_out_of_order_state_corruption`, `sse_no_lastEventId_resume`, and conditionally `websocket_backpressure_no_drop`.
- New runner: `packages/cli/src/security/realtime-fault-runner.ts`. Mirrors `network-fault-runner.ts` shape exactly.
- New palette: `packages/cli/src/security/realtime-fault-palette.ts`. Six variants per § 5.
- Adapter extension: `BrowserMcpAdapter` and `TabScope` gain optional `applyRealtimeFault` / `clearRealtimeFault` / `observeRealtime` / `drainRealtimeFrames` methods. Called via the SDK Client's `callTool` (V49 contract).
- Active-fault classifiers: `classify/realtime-out-of-order.ts`, `classify/sse-resume.ts`, `classify/realtime-backpressure.ts` (conditional).
- Telemetry on `summary.json.realtimeFaults`.
- CLI flag `--realtime-faults` (default `off`).
- Validate-phase capability probe; abort path.
- Fixture additions for active routes (V50.2 PR adds three routes to `fixtures/realtime-bad/`).
- Sibling: camofox-mcp v0.7 PR (separate repo, separate review).

**Cost:** ~800 lines runner + adapter + classifiers + types; ~500 lines tests; sibling camofox-mcp ~400 lines.

**Shippable independently:** yes; only V50.2's active BugKinds gate on camofox-mcp v0.7. V50.1 has already landed by then.

### 9.3 Why this is the right cut

V50.1 ships value with no external dependency cycle. The hardest part of v0.20 was the camofox-mcp dependency crunch (~3 weeks lag); V50.1 sidesteps by reading the parallel-Chromium CDP session that's already in the build. V50.2 inherits v0.20's exact dependency-coordination playbook, so the second PR is a known shape.

---

## 10. Acceptance criteria

| Criterion | Phase | Verifier |
|---|---|---|
| `npx tsc --noEmit` clean across both packages | V50.1 + V50.2 | `tsc` |
| `npx eslint . --max-warnings 0` clean | V50.1 + V50.2 | `eslint` |
| Unit tests for the realtime-observer's CDP-event partitioning | V50.1 | `npx vitest run realtime/realtime-observer` |
| Unit tests for each passive classifier with synthetic frame fixtures | V50.1 | `npx vitest run classify/realtime classify/sse` |
| Unit tests for cluster signatures (8 or 9 cases) | V50.1 + V50.2 | `npx vitest run cluster/signature` |
| Unit tests for the fault palette + denylist filter | V50.2 | `npx vitest run security/realtime-fault-palette` |
| Unit tests for active-fault classifiers | V50.2 | `npx vitest run classify/realtime-out-of-order classify/sse-resume classify/realtime-backpressure` |
| Validate phase aborts with `camofox-mcp ≥ v0.7 required` if `applyRealtimeFault` is undefined | V50.2 | `npx vitest run phases/validate` |
| Unit test verifying `clearRealtimeFault` is called in `finally` even if action throws | V50.2 | `npx vitest run phases/execute` |
| Integration smoke against `fixtures/realtime-bad/` produces ≥1 finding per BugKind with correct `realtimeContext` and `proof` | V50.1 + V50.2 | `npx vitest run integration/realtime-smoke` |
| Same-shape collapse: 50 buttons sharing a signature → 1 fault test per (variant, role) | V50.2 | `npx vitest run phases/plan` |
| `realtime.suppressOnFirstFrameAuth=true` suppresses `realtime_connection_unauthenticated` when first outbound frame contains JWT-shape token | V50.1 | unit test |
| Telemetry: `summary.json.realtime` populated (V50.1) and `summary.json.realtimeFaults` populated (V50.2) | both | `jq` |
| Per-tool denylist honored: a tool listed in `realtimeFaults.toolDenylist` has zero fault tests | V50.2 | unit test |
| Reset semantics: a happy-path test scheduled directly after a realtime-fault test passes cleanly with no residual fault behaviour | V50.2 | integration test |
| Negative smoke on Aspectv3 (no realtime): zero `realtime_*` findings | V50.1 | manual smoke (post-merge) |
| Negative smoke on TraiderJo (uses SSE): no false `sse_no_lastEventId_resume` or `sse_infinite_reconnect_storm` under healthy network | V50.1 | manual smoke (post-merge) |
| `RealtimeConnectionLog` is wiped in `withTab`'s finally — verified by unit test asserting two consecutive tabs do not share log entries | V50.1 | `npx vitest run realtime/realtime-observer` |

Each acceptance criterion above is testable; "it works" is not on the list.

---

## 11. Files to touch / add

### 11.1 V50.1 (one PR)

#### To touch
- `packages/cli/src/types.ts` — six new `BugKind` variants (passive set); `RealtimeContext` type; `RealtimeFrame` types; `RealtimeConfig`; `RealtimeTelemetry`; append to `BugHunterConfig`; optional `realtimeContext?` on `BugDetection`.
- `packages/cli/src/phases/classify.ts` — six new `KIND_PRIORITY` slots between `network_5xx` and `network_4xx_unexpected`. (`realtime_connection_unauthenticated` near the top, `_pii_in_broadcast` near the top, the rest mid-band.)
- `packages/cli/src/cluster/signature.ts` — six new cases (variant included only for kinds that have a fault variant — V50.1 kinds don't; V50.2 adds three more).
- `packages/cli/src/adapters/cdp-session.ts` — extend the existing CDP-event subscriber to include `Network.webSocketCreated`, `webSocketWillSendHandshakeRequest`, `webSocketHandshakeResponseReceived`, `webSocketFrameSent`, `webSocketFrameReceived`, `webSocketFrameError`, `webSocketClosed`, `eventSourceMessageReceived`. Forward to the realtime observer.
- `packages/cli/src/adapters/har-writer.ts` — add `realtime` artifact-writer hook: per `actionWindowId`, write `realtime/<actionWindowId>.ndjson` with the frame log. (Tiny — ~40 lines.)
- `packages/cli/src/cli/run.ts` — `--realtime-detect` / `--no-realtime-detect` flag wiring.
- `packages/cli/src/phases/emit.ts` — populate `summary.json.realtime`.
- `packages/cli/src/phases/execute.ts` — wire the realtime observer's per-tab lifecycle into `withTab`'s setup/teardown.

#### To create
- `packages/cli/src/realtime/realtime-observer.ts` — observer module: subscribes to CDP, partitions per-`actionWindowId` and per-tab, exposes `getFramesForWindow(windowId)` + `getConnectionLog(tabId)`.
- `packages/cli/src/realtime/realtime-types.ts` — shared types: `RealtimeFrame`, `RealtimeConnectionLog`, `RealtimeContext`.
- `packages/cli/src/realtime/realtime-observer.test.ts`
- `packages/cli/src/classify/realtime-auth.ts` + `.test.ts`
- `packages/cli/src/classify/realtime-reconnect.ts` + `.test.ts`
- `packages/cli/src/classify/realtime-pii.ts` + `.test.ts`
- `packages/cli/src/classify/realtime-mixed-content.ts` + `.test.ts`
- `packages/cli/src/classify/realtime-message-exception.ts` + `.test.ts`
- `packages/cli/src/classify/sse-reconnect-storm.ts` + `.test.ts`
- `fixtures/realtime-bad/` — Bun + `ws` server + minimal SPA exercising the six passive routes. `package.json` scripts `dev`, `start`. `README.md` documenting each planted bug.
- `tests/integration/realtime-smoke.test.ts` — end-to-end against the fixture.

### 11.2 V50.2 (second PR, after V50.1 + camofox-mcp v0.7)

#### To touch
- `packages/cli/src/types.ts` — add `RealtimeFaultSpec`, `realtime_fault_*` BugKinds (3, +1 conditional), `RealtimeFaultsConfig`, `RealtimeFaultsTelemetry`, `faultInjectedRealtime?` on `TestCase`.
- `packages/cli/src/phases/classify.ts` — three (or four) new priority slots; suppression rule for fault-context (drop `network_5xx` etc. as v0.20 does).
- `packages/cli/src/cluster/signature.ts` — three (or four) new cases (variant included).
- `packages/cli/src/phases/plan.ts` — emit realtime-fault TestCases per (collapsed-action-signature, role, variant).
- `packages/cli/src/phases/execute.ts` — when `tc.faultInjectedRealtime !== undefined`, wrap action in `applyRealtimeFault` → action → `clearRealtimeFault`.
- `packages/cli/src/phases/validate.ts` — capability probe + abort path.
- `packages/cli/src/adapters/browser-mcp.ts` — add optional `applyRealtimeFault` / `clearRealtimeFault` / `observeRealtime` / `drainRealtimeFrames` on adapter + `TabScope`. Implementations call the SDK Client (V49 contract).
- `packages/cli/src/cli/run.ts` — `--realtime-faults` / `--no-realtime-faults` flag wiring.
- `packages/cli/src/phases/emit.ts` — populate `summary.json.realtimeFaults`.

#### To create
- `packages/cli/src/security/realtime-fault-palette.ts` — six-variant table, default subset, denylist filter.
- `packages/cli/src/security/realtime-fault-runner.ts` — config + telemetry types + runner-level helpers.
- `packages/cli/src/security/realtime-fault-palette.test.ts`
- `packages/cli/src/security/realtime-fault-runner.test.ts`
- `packages/cli/src/classify/realtime-out-of-order.ts` + `.test.ts`
- `packages/cli/src/classify/sse-resume.ts` + `.test.ts`
- `packages/cli/src/classify/realtime-backpressure.ts` + `.test.ts` (conditional)
- `fixtures/realtime-bad/` — extend with the active routes (`/out-of-order`, `/sse-resume-broken`, `/backpressure`).

#### Outside this PR (sibling dependency, camofox-mcp + camofox-browser)
- `/opt/camofox-mcp/index.ts` — register `realtime_observe`, `realtime_drain`, `realtime_fault`, `clear_realtime_fault` tools.
- `/root/.openclaw/extensions/camofox-browser/server.js` — implement `POST/GET/POST/DELETE` realtime endpoints via Playwright `BrowserContext.routeWebSocket()` and `route()` for SSE.

---

## 12. Negative requirements

- Do **not** ship V50.2 in the V50.1 PR. They are independently shippable; conflating doubles review burden.
- Do **not** modify the existing v0.20 `NetworkFaultRunner` to dispatch realtime variants. Realtime faults are a separate runner with separate cost defaults; co-locating creates the same anti-pattern v0.40 explicitly avoided when it kept multi-context separate from race-runner.
- Do **not** introduce a parallel mutation system. The realtime fault-runner reuses the v0.20 `same-shape collapse → per-test cap → fresh tab via withTab → telemetry struct` pattern verbatim, with realtime-specific defaults.
- Do **not** count realtime-fault tests against `--max-bugs` cluster cap separately. Same per-cluster cap; per-test budget is separate.
- Do **not** plant realtime faults on toolIds matching `*/auth/*`, `*/login`, `*/payment*`, `*/oauth*`. Reuse v0.20's denylist — and add a realtime-specific denylist for known-volatile WS endpoints (`*/agent`, `*/livekit`, `*/realtime/v1/*` — Supabase) that the user can opt back in via `aggressiveRealtimeTargets`.
- Do **not** retry realtime-fault tests under `reRunForFlakes`. Mark them `flakySkipped: true` (mirror v0.20).
- Do **not** treat WS frame logs as full-fidelity records. The CDP + Playwright capture has known truncation at 4 KiB per frame; documented in the artifact.
- Do **not** open a real WS connection from BugHunter during the validate-phase capability probe against a public WS service. Spin up a tiny in-process `ws` server on a random port; tear it down after the probe. (Same pattern v0.20 uses for offline probe.)
- Do **not** silently skip when camofox lacks the underlying tool. Hard-fail validate.
- Do **not** read the WS frame body for PII detection if the body is binary (opcode `0x2`). PII detector skips with `secondaryObservations: [{ kind: 'observation', detail: 'ws_binary_frame_skipped' }]`.
- Do **not** treat a single WS reconnect (one open → close → open within 30 s, after 5+ s gap) as `sse_infinite_reconnect_storm`. The detector requires >10 reconnects with sub-3-second gaps and no monotonic-backoff signal.
- Do **not** add WebTransport, WebRTC, or gRPC-Web detection. Out of scope per § 2.2; if telemetry shows demand, file V51.
- Do **not** instrument app code (no monkey-patched `WebSocket`, no patched `EventSource`, no SW registration). All capture is via CDP / Playwright `routeWebSocket` / Playwright `route`. Mirrors v0.40's no-app-instrumentation rule.

---

## 13. Task breakdown

### 13.1 V50.1 tasks

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Add six `BugKind` variants + `RealtimeFrame` + `RealtimeContext` + `RealtimeConfig` + `RealtimeTelemetry` + optional `realtimeContext?` on BugDetection | `types.ts` | none |
| 2 | Implement `realtime-observer.ts` — subscribe to CDP WS/SSE events, partition per-window + per-tab, expose lookup methods | `realtime/realtime-observer.ts`, `realtime/realtime-types.ts`, tests | 1 |
| 3 | Wire `cdp-session.ts` to forward the seven WS events and `eventSourceMessageReceived` to the observer | `adapters/cdp-session.ts` | 2 |
| 4 | Implement six passive classifiers as pure functions with unit tests | `classify/realtime-*.ts`, `classify/sse-*.ts`, tests | 1, 2 |
| 5 | `KIND_PRIORITY` slotting for the six new kinds | `phases/classify.ts`, tests | 1 |
| 6 | Cluster-signature cases for the six kinds | `cluster/signature.ts`, tests | 1 |
| 7 | Per-tab lifecycle in `withTab` (init observer / drain on teardown) | `phases/execute.ts`, tests | 2 |
| 8 | Frame-log artifact writer | `adapters/har-writer.ts` | 2 |
| 9 | Telemetry: `summary.json.realtime` | `phases/emit.ts`, types | 4 |
| 10 | CLI flag wiring (`--realtime-detect` / `--no-realtime-detect`) | `cli/run.ts` | 1 |
| 11 | Synthetic fixture `fixtures/realtime-bad/` with six passive routes | `fixtures/realtime-bad/` | none (parallel to runner work) |
| 12 | Integration smoke test against the fixture | `tests/integration/realtime-smoke.test.ts` | 1-11 |
| 13 | Manual smoke on Aspectv3 / TraiderJo (zero-or-real findings audit) | (manual) | 1-12 |

### 13.2 V50.2 tasks

| # | Task | Files | Deps |
|---|---|---|---|
| V2.1 | Add three (or four) `BugKind` variants + `RealtimeFaultSpec` + `RealtimeFaultsConfig` + `RealtimeFaultsTelemetry` + `faultInjectedRealtime?` on TestCase | `types.ts` | V50.1 done |
| V2.2 | Implement `realtime-fault-palette.ts` with six variants + default subset + denylist filter + unit tests | `security/realtime-fault-palette.ts`, tests | V2.1 |
| V2.3 | Add `applyRealtimeFault` / `clearRealtimeFault` / `observeRealtime` / `drainRealtimeFrames` to `BrowserMcpAdapter` + `TabScope` (calls into camofox-mcp v0.7 tools) | `adapters/browser-mcp.ts` | V2.1 + camofox-mcp v0.7 |
| V2.4 | Plan-phase emission of realtime-fault-injected TestCases (collapsed) | `phases/plan.ts`, tests | V2.1, V2.2 |
| V2.5 | Execute-phase fault wrapping (apply → action → clear in `finally`) | `phases/execute.ts`, tests | V2.3, V2.4 |
| V2.6 | Three (or four) active-fault classifiers (pure functions) + tests | `classify/realtime-out-of-order.ts`, `classify/sse-resume.ts`, `classify/realtime-backpressure.ts` (conditional), tests | V2.1 |
| V2.7 | Classifier suppression rules under realtime-fault context + KIND_PRIORITY slotting | `phases/classify.ts`, tests | V2.1, V2.6 |
| V2.8 | Cluster signatures for the new kinds + cross-kind link (mirror v0.20's pattern) | `cluster/signature.ts`, tests | V2.1 |
| V2.9 | Validate-phase capability probe + abort path | `phases/validate.ts`, tests | V2.3 |
| V2.10 | Telemetry: `summary.json.realtimeFaults` | `phases/emit.ts`, types | V2.5, V2.6 |
| V2.11 | CLI flag wiring (`--realtime-faults` / `--no-realtime-faults`) | `cli/run.ts` | V2.1 |
| V2.12 | Add three active routes to `fixtures/realtime-bad/` | `fixtures/realtime-bad/` | V50.1 done |
| V2.13 | Integration smoke (extend `realtime-smoke.test.ts`) | `tests/integration/realtime-smoke.test.ts` | V2.1-V2.12 |
| V2.14 | Manual smoke on Aspectv3 / TraiderJo with `--realtime-faults` | (manual) | V2.1-V2.13 |
| Sibling | camofox-mcp `realtime_observe` / `realtime_drain` / `realtime_fault` / `clear_realtime_fault` tools | `/opt/camofox-mcp/index.ts`, `/root/.openclaw/extensions/camofox-browser/server.js` | none (parallel) |

---

## 14. Definition of Done

A reviewer can:

```bash
# V50.1
cd /root/Aspectv3
node /root/BugHunter/packages/cli/dist/cli/main.js run --max-bugs 100 --budget 1800000
# observe: summary.json.realtime block present, no false positives.

cd /root/BugHunter/fixtures/realtime-bad && bun start &
cd /root/BugHunter
node packages/cli/dist/cli/main.js run --target http://localhost:3055 --max-bugs 50
# observe: ≥1 finding per V50.1 BugKind with correct realtimeContext + proof.

# V50.2 (post camofox-mcp v0.7)
cd /root/BugHunter/fixtures/realtime-bad && bun start &
cd /root/BugHunter
node packages/cli/dist/cli/main.js run \
  --target http://localhost:3055 \
  --realtime-faults --max-bugs 200 --budget 3600000
# observe:
# - Validate phase confirms camofox-mcp supports realtime_fault; aborts otherwise.
# - Plan phase emits realtime-fault TestCases collapsed by signature.
# - Execute phase runs fault tests with apply / clear; frame-log artifacts written
#   to realtime/<actionWindowId>.ndjson per fault test.
# - Classify suppresses network_5xx / network_4xx_unexpected for fault-injected
#   results; emits the three (or four) new active BugKinds where appropriate.
# - summary.json.realtimeFaults block reports faults attempted / succeeded /
#   skipped / detections by kind / duration.
# - Synthetic fixture smoke captures one finding per V50.2 BugKind with correct
#   faultVariant and proof.
# - A happy-path test running directly after a fault test passes cleanly.
```

---

## 15. Risks + escape hatches

- **Risk: Camoufox lacks Playwright `routeWebSocket` support.** Per § 6.4 — mitigated by routing V50.2 fault injection through the parallel-Chromium session (which Playwright supports rock-solidly). Detection still happens off camofox DOM observation; the active-fault test executes in Chromium, observation in Firefox, both already running per session. Documented as a fallback; primary path assumes camofox-mcp v0.7 + Playwright Firefox 1.48 work.
- **Risk: false positives on apps with auth-via-first-frame patterns.** Mitigated by `realtime.suppressOnFirstFrameAuth = true` default (§ 8.1).
- **Risk: PII detector false positives on apps that legitimately broadcast user-shaped data (chat with @mentions including emails).** Mitigation: `realtime.piiAllowlist: string[]` config — globs over endpoint URLs that exempt PII detection. Document in fixture README that legitimately-public PII (e.g. social profiles) needs allowlisting.
- **Risk: real-world dev servers can't survive a `slow_consumer` test holding frames for 5 s while the client buffers.** Mitigated by `perTestMaxMs` cap; documented under `realtimeFaults.perVariantPerTestMs.slow_consumer`. Default 5000 ms hold + 2× `asyncMaxWaitMs` cap.
- **Risk: Frame-log artifacts blow disk budget.** WS chat apps emit 100s of frames/sec. Mitigation: per-window frame log is hard-capped at 1000 frames; overflow is summarized as `{ frame_count: N, truncated_at: 1000 }`. Same artifact-budget pattern v0.20 uses.
- **Risk: camofox-mcp v0.7 lands late.** Mitigation: V50.1 ships independently of V50.2; CI-gated `realtime-smoke.test.ts` for V50.2 sits behind `process.env.CAMOFOX_REALTIME_FAULT === '1'` until upstream ships. V50.1 has no such gate.
- **Risk: Bun is not installed in the CI runner used by `realtime-smoke.test.ts`.** Mitigation: the fixture's `package.json` lists `bun` as a devDependency; CI installs Bun via `setup-bun@v1` in the workflow. Fall back to `node` + the npm `ws` package for the fixture if Bun is unavailable; document the choice in `fixtures/realtime-bad/README.md`.
- **Escape hatch:** `bughunter run --no-realtime-detect --no-realtime-faults` disables both phases entirely.

---

## 16. Killer-demo runbook

```bash
# 1. V50.1 synthetic-fixture smoke
cd /root/BugHunter && bun --cwd fixtures/realtime-bad start &
cd /root/BugHunter && \
  npx vitest run tests/integration/realtime-smoke
# Expect ≥1 finding per V50.1 passive BugKind with proof field.

# 2. V50.2 synthetic-fixture smoke (after camofox-mcp v0.7 lands)
cd /root/BugHunter && \
  CAMOFOX_REALTIME_FAULT=1 npx vitest run tests/integration/realtime-smoke
# Expect ≥1 finding per V50.2 active BugKind with faultVariant + proof.

# 3. Real-app smoke on TraiderJo (uses SSE for live PnL)
cd /root/TraiderJo
node /root/BugHunter/packages/cli/dist/cli/main.js run \
  --realtime-detect --max-bugs 200 --budget 1800000
RUN=$(ls -t /root/TraiderJo/.bughunter/runs/ | head -1)
jq '.realtime' /root/TraiderJo/.bughunter/runs/$RUN/summary.json
jq '.byKind | with_entries(select(.key | startswith("realtime") or startswith("websocket") or startswith("sse")))' \
  /root/TraiderJo/.bughunter/runs/$RUN/summary.json
```

---

## 17. Open questions

1. **Does Camoufox's Firefox fork support Playwright `BrowserContext.routeWebSocket()`?** Critical for V50.2. If not, V50.2 fault-injection routes through the parallel-Chromium session (§ 6.4 fallback). Verifiable in 30 minutes by running a smoke against `wss://echo.websocket.org` from a Camoufox-launched Playwright instance and asserting `context.routeWebSocket(...)` intercepts. **Action:** before V50.2 implementation starts, the implementer runs this verification and reports back.

2. **Should `websocket_backpressure_no_drop` ship in V50.2 or punt to v0.51?** Detector is the highest false-positive-risk in the set; JS heap signals are noisy. Recommendation: ship behind `realtime.detectBackpressure: false` default; users opt in. Telemetry from the first three integration runs decides whether the default flips. Spec-level decision: include the kind, default off.

3. **Scope of the JWT-shape token detector for `realtime.suppressOnFirstFrameAuth`.** Currently regex-only. Apps using opaque tokens (random hex strings) won't be matched; their handshake-without-auth-header pattern fires the false positive. Should the suppression also match arbitrary `{ type: 'auth', token: '<any non-empty string>' }` first-frame shape? Recommendation: yes, with a JSON-shape probe of the first frame (parse, look for keys named `auth | token | jwt | bearer | apiKey` case-insensitive). Adds ~30 lines; documented under `realtime.firstFrameAuthShapes` config.

4. **Frame-log retention.** The artifact `realtime/<actionWindowId>.ndjson` is hard-capped at 1000 frames. Should we also rotate / compress on disk? Recommendation: no compression in V50.1 (artifacts are already compressed at run-archive time); reopen if telemetry shows >5 MiB/run is common.

5. **Does V50.1's per-tab `RealtimeConnectionLog` survive inter-test resets?** Spec says no — `withTab`'s `finally` wipes it. But chat-style apps connect once and stay connected across many actions; if the lifecycle log gets wiped, `sse_infinite_reconnect_storm` (which needs 10+ connection attempts) cannot fire because each test is a fresh tab. **Decision:** the storm detector consults the ENTIRE-run log, not per-tab. Add a `RunRealtimeLog` aggregator that survives across tabs; storm detection runs at end-of-run cluster phase. (Mirror how V25 detects bursty-pattern bugs across action windows.)

6. **What happens if a V50.2 fault test causes the WS to reconnect to a different URL than the original?** (Apps sometimes upgrade ws→wss or migrate to a new host on retry.) The fault is installed on the original URL pattern; the new URL escapes the fault. Recommendation: install the fault on the URL pattern observed AT FAULT-APPLICATION TIME; if the client reconnects to a different host, the fault is no longer in effect and the test reports `secondaryObservations: [{ kind: 'observation', detail: 'reconnect_url_changed_fault_escaped' }]`. Not a bug; a coverage limitation.

7. **Should V50 ship a config-level `realtime.expectedRealtimeProtocol: 'ws' | 'sse' | 'either' | 'none'`?** Lets users assert "this app uses WS only — fire `discovery.no_realtime_observed` if the walk sees zero WS connections." Recommendation: defer to v0.51; over-spec for a first pass.
