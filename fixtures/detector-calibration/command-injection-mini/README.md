# command-injection-mini — detector calibration fixture

## Purpose

Minimal fixture for `command_injection` detector calibration. Plants two shell-injection
vulnerabilities that execute user-supplied strings directly via `exec()` without any
sanitization or argument separation.

## Planted bugs

**P1: `target` field shell concat** (`edgeLabel: shell-metachar-direct`)
`POST /api/admin/health` with body `{ "target": "127.0.0.1; cat /etc/passwd" }` passes the
value directly to `exec('ping -c 1 ' + body.target)`. The semicolon splits into two shell
commands; `cat /etc/passwd` executes. Nonce echo-back is detectable in stdout.

**P2: `domain` field shell concat** (`edgeLabel: command-substitution`)
Same endpoint with body `{ "domain": "$(id)" }` passes the value to
`exec('nslookup ' + body.domain)`. Command substitution expands `$(id)` and the output
of `id` appears in the response. Different signature prefix to P1.

**P3: argument injection via flag** (`edgeLabel: argument-injection-via-flag`)
`POST /api/admin/health` with body `{ "target": "-vv --some-evil-flag" }` concatenated to
a known executable. The flag is passed to the shell as part of the string; flag injection
fires when the concatenated argument is passed through as a shell token.

## Safe endpoint (negative control)

**N1: `execFile` with array args** (`/api/admin/health-safe`)
`POST /api/admin/health-safe` with body `{ "target": "127.0.0.1; cat /etc/passwd" }` calls
`execFile('ping', ['-c', '1', target])`. The target is passed as a literal argument — the
shell is never invoked and metacharacters are not expanded. Detector must stay silent.

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

## Expected assertions (V56.2 4-shape minimum)

| # | Shape | edgeLabel | expect | Route |
|---|---|---|---|---|
| 1 | Positive edge | `shell-metachar-direct` | fires | `/api/admin/health` |
| 2 | Positive edge | `command-substitution` | fires | `/api/admin/health` |
| 3 | Positive edge | `argument-injection-via-flag` | fires | `/api/admin/health` |
| 4 | Negative | — | silent | `/api/admin/health-safe` |
| 5 | Silent | — | silent | `/api/admin/health` (400 — no field) |
| 6 | Silent | — | silent | `/api/admin/health` (GET → 404) |
| 7 | Degradation | — | skipped | fixture_unreachable |
