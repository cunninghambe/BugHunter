# v0.49 Browser MCP Transport Migration Guide

## What changed

BugHunter v0.49 replaces the hand-rolled JSON-RPC transport in the browser adapter
with the official `@modelcontextprotocol/sdk` `Client`. The old adapter was named
`CamofoxBrowserMcpAdapter` but did not actually use MCP — it assembled JSON-RPC
envelopes manually over `fetch`. This caused protocol-drift risk and prevented use
of SDK features like capability discovery and stdio transport.

### Rename

| v0.48 name | v0.49 name | Notes |
|---|---|---|
| `CamofoxBrowserMcpAdapter` | `CamofoxBrowserMcpAdapter` | **New SDK-based implementation**. Default. |
| (did not exist) | `CamofoxBrowserHttpAdapter` | Renamed from old class. Deprecated. |

The `BrowserMcpAdapter` interface is **unchanged**. All 42 call-sites compile without modification.

## Why

1. **Honest naming.** The new `CamofoxBrowserMcpAdapter` actually uses the MCP SDK.
2. **Protocol correctness.** The SDK handles multi-frame SSE responses, session IDs, and
   capability negotiation — things the hand-rolled implementation silently dropped.
3. **Capability discovery.** The SDK `client.listTools()` enables doctor checks and
   forward-compat with new camofox-mcp tools.
4. **Stdio transport.** The SDK's `StdioClientTransport` allows BugHunter to spawn
   camofox-mcp as a per-run subprocess for CI isolation.

## How to migrate

### Default behavior (no config change needed)

Existing `.bughunter/config.json` files without a `browserTransport` field automatically
use `mcp-http` (the SDK Client over HTTP). The wire format is identical to v0.48 — same
MCP server at `127.0.0.1:3104`, same JSON-RPC envelope. No behavior difference expected.

### For users with custom adapters

The `BrowserMcpAdapter` interface is unchanged. Custom adapters implementing this interface
compile without modification.

### For users who want the legacy behavior

If you encounter issues with the new transport and need to revert to the hand-rolled
JSON-RPC implementation for debugging:

```json
{
  "browserTransport": "http-legacy"
}
```

Or via CLI flag:
```bash
bughunter run --browser-transport http-legacy
```

This will emit a deprecation warning. The `http-legacy` option will be removed in v0.50.

### For CI environments (stdio transport)

To run camofox-mcp as a per-run subprocess (no pre-deployed daemon needed):

```json
{
  "browserTransport": "mcp-stdio",
  "browserMcpStdio": {
    "command": "node",
    "args": ["/opt/camofox-mcp/dist/index.js"]
  }
}
```

Or via CLI:
```bash
bughunter run --browser-transport mcp-stdio
```

This is useful in CI environments where camofox-mcp is not pre-deployed, or when running
multiple BugHunter instances against different camofox-browser instances in parallel.

## Transport comparison

| Transport | Use case | Notes |
|---|---|---|
| `mcp-http` (default) | Production, local dev | SDK Client + HTTP. Same behavior as v0.48. |
| `mcp-stdio` | CI isolation, parallel runs | SDK Client + subprocess. Higher cold-start (~120ms); slightly lower per-call latency. |
| `http-legacy` | Debug only | Hand-rolled JSON-RPC over fetch. Deprecated; removed in v0.50. |

## New config fields (v0.49)

- `browserTransport`: `'mcp-http' | 'mcp-stdio' | 'http-legacy'` — default `'mcp-http'`
- `browserMcpAuthKey`: Bearer token for camofox-mcp authentication (falls back to `CAMOFOX_MCP_KEY` env var)
- `browserMcpStdio.command`: Path to camofox-mcp binary (required for `mcp-stdio`)
- `browserMcpStdio.args`: CLI arguments for the binary

## What's next (v0.50)

- `CamofoxBrowserHttpAdapter` and `browserTransport: 'http-legacy'` will be removed.
- Anyone still using the legacy adapter will get a clear error pointing to this guide.
