# sensitive-data-url-mini

Minimal fixture for the `sensitive_data_in_url` detector.

## What's planted

| # | URL | Sensitive param | Detection rationale |
|---|-----|-----------------|---------------------|
| P1 | `GET /reset-password?token=abc123def456` | `token` | Password-reset link with token in query string; logs leak it |
| P2 | `GET /api/admin?api_key=secret_test_key_123` | `api_key` | API key in query string |

The index page (`/`) links to both planted URLs so the crawler observes them during a standard crawl.

## How the detector fires

`analyzeSensitiveUrl` in `packages/cli/src/security/header-probe.ts` scans each observed URL against `SENSITIVE_URL_PARAMS` (`token`, `api_key`, `password`, etc.). When the crawler visits `/` and follows the planted links, the detector sees both URLs and emits a `sensitive_data_in_url` detection for each.

## Port

`9975`

## Running

```bash
bash bin/up.sh          # start
bash bin/reset.sh       # reset (stateless no-op)
bash bin/down.sh        # stop
```
