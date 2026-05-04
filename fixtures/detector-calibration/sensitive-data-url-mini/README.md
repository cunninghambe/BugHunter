# sensitive-data-url-mini

Minimal fixture for the `sensitive_data_in_url` detector. Covers the V56 4-shape test minimum: positive fires, a negative (silent), two edge cases with `edgeLabel`, and an input-degradation skip.

## What's planted

| # | URL / Route | Sensitive param | Shape | Detection rationale |
|---|-------------|-----------------|-------|---------------------|
| P1 | `GET /reset-password?token=abc123def456` | `token` | fires | Password-reset link with token in query string; access logs leak it |
| P2 | `GET /api/admin?api_key=secret_test_key_123` | `api_key` | fires | API key in query string |
| P3 | `GET /api/v1/key/abc123def456/items` | key in path segment | fires (edgeLabel: `api-key-in-path-segment`) | API key embedded as a path component rather than a query param — distinct from query-string detection |
| N1 | `POST /login-safe` | credentials in body | silent (negative) | Credentials sent via POST body and `Authorization` header never appear in the URL; detector must be silent |

The index page (`/`) links to P1, P2, and P3 so the crawler observes them during a standard crawl.

## Edge cases

### `token-in-url-fragment` (`/login#token=abc`)

**Expected outcome: `silent`.**

The URL fragment (`#...`) is processed entirely by the browser. It is stripped before the HTTP request leaves the client, so the server never receives it and the detector — which operates on observed server-side URLs — cannot see it. Client-side navigation history and the browser's address bar do retain the fragment, which is a separate concern (client-side token leakage) outside the URL-transit threat model this detector covers.

No server route is needed for this case; the assertion in `expected-clusters.jsonl` is documentation-only for the harness.

### `api-key-in-path-segment` (`/api/v1/key/abc123def456/items`)

**Expected outcome: `fires` (distinct cluster from query-string detection).**

When an API key appears as a path segment rather than a `?key=...` query param, it is still transmitted in the URL and captured in access logs. The detector should fire on this pattern independently of the query-string variant.

## Input degradation

When the fixture's index page returns 404 (i.e. the fixture is not booted or the port is wrong), the harness has no pages to crawl. The assertion with `expect: "skipped"` and `reason: "no_pages_to_probe"` tells the harness to skip rather than fail in this condition.

## How the detector fires

`analyzeSensitiveUrl` in `packages/cli/src/security/header-probe.ts` scans each observed URL against `SENSITIVE_URL_PARAMS` (`token`, `api_key`, `password`, etc.). When the crawler visits `/` and follows the planted links, the detector sees the URLs for P1, P2, and P3 and emits a `sensitive_data_in_url` detection for each. POST `/login-safe` is never visited as a crawled URL, so N1 stays silent.

## Port

`9975`

## Running

```bash
bash bin/up.sh          # start
bash bin/reset.sh       # reset (stateless no-op)
bash bin/down.sh        # stop
```
