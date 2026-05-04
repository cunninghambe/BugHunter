# idor-mini — detector calibration fixture

## Purpose

Minimal fixture for `idor_horizontal_read` detector calibration. Plants two IDOR vulnerabilities
that allow one authenticated user to read another user's private resources with no 403 response.

## Planted bugs

**P1: Order read without ownership check**
`GET /api/orders/:id` returns any order regardless of which user is authenticated.
Alice (Bearer `alice-token`) can read `bob-order-1`, and vice versa.

**P2: Profile read without identity check**
`GET /api/users/:id/profile` returns any user's profile without verifying the requesting user
matches the path parameter. Alice can read `/api/users/bob/profile`.

## Auth

Bearer-token auth. Two seed tokens:
- `alice-token` — authenticates as user `alice`
- `bob-token` — authenticates as user `bob`

## Port

`9978`

## Running

```bash
bash bin/up.sh    # boots on port 9978
bash bin/down.sh  # stops
bash bin/reset.sh # reset endpoint (no-op for this fixture; state is in-memory)
```

## Expected assertions

- P1 fires: alice reads bob-order-1 → 200 (should be 403)
- P2 fires: alice reads /api/users/bob/profile → 200 (should be 403)
- Silent: alice reads alice-order-1 → legitimate own-data access, no IDOR
- Silent: unauthenticated request → 401, no IDOR possible
