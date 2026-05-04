# command-injection-mini — detector calibration fixture

## Purpose

Minimal fixture for `command_injection` detector calibration. Plants two shell-injection
vulnerabilities that execute user-supplied strings directly via `exec()` without any
sanitization or argument separation.

## Planted bugs

**P1: `target` field shell concat**
`POST /api/admin/health` with body `{ "target": "..." }` passes the value directly to
`exec('ping -c 1 ' + body.target)`. A payload like `127.0.0.1; id` runs two commands.

**P2: `domain` field shell concat**
Same endpoint with body `{ "domain": "..." }` passes the value to
`exec('nslookup ' + body.domain)`. Identical injection pattern, different command prefix.

## Auth

No authentication required. The endpoint is unauthenticated by design (admin health check).

## Port

`9979`

## Running

```bash
bash bin/up.sh    # boots on port 9979
bash bin/down.sh  # stops
bash bin/reset.sh # reset endpoint (no-op; process-level state only)
```

## Expected assertions

- P1 fires: POST `{ target }` → shell exec with user input, nonce echo-back detectable
- P2 fires: POST `{ domain }` → shell exec with user input, nonce echo-back detectable
- Silent: POST with neither field → 400, no exec
- Silent: GET request → 404, exec path never reached
