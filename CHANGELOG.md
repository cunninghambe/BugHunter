# Changelog

All notable changes to BugHunter are documented here.

## [Unreleased]

### Fixed

- **fix(transport): friendly error for mcp-http on legacy camofox-mcp (#115)**
  When `browserTransport` is `mcp-http` (the default since v0.42) and the configured
  camofox-mcp server does not advertise the Streamable HTTP MCP transport, BugHunter
  now throws a clear error at startup rather than failing silently mid-run.

  Error message: `Your camofox-mcp at <url> does not advertise the mcp-http transport.
  Either upgrade camofox-mcp to ≥0.3.0 or set 'browserTransport: "http-rest"' in your config.`

## v0.42

### Breaking / Migration Note

**`browserTransport` default changed to `'mcp-http'`.**

If you are running camofox-mcp older than v0.3.0, add the following to your
`bughunter.config.json` to restore the previous behaviour:

```json
{
  "browserTransport": "http-rest"
}
```

To upgrade camofox-mcp: `npm install -g camofox-mcp@latest` (requires v0.3.0+).
