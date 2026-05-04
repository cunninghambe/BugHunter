# idor-mini — detector calibration fixture

## Purpose

Minimal fixture for `idor_horizontal_read` detector calibration. Plants IDOR vulnerabilities
that allow one authenticated user to read another user's private resources with no 403 response.
Covers the four assertion shapes required by V56 section 17: fires, negative (silent), edge cases
with `edgeLabel`, and input-degradation (skipped).

## Planted bugs

**P1: Order read without ownership check**
`GET /api/orders/:id` returns any order regardless of which user is authenticated.
Alice (Bearer `alice-token`) can read `bob-order-1`, and vice versa.
Named-ID and numeric-ID variants both lack the ownership check.

**P2: Profile read without identity check**
`GET /api/users/:id/profile` returns any user's profile without verifying the requesting user
matches the path parameter. Alice can read `/api/users/bob/profile`.

**P3 (edge — `numeric-id-iteration`): Numeric-keyed orders**
Same missing ownership check as P1, on integer IDs (`1001`, `1002`). Numeric IDs are trivially
iterable by increment; the detector must still fire even when the harness cannot discover the IDs
through ordinary crawl. Routes: `GET /api/orders/1001`, `GET /api/orders/1002`.

**P4 (edge — `uuid-iteration`): UUID-keyed orders**
Same missing ownership check, but IDs are UUIDv7 (`01HW9X…`). Harder to enumerate by brute-force.
The detector fires by replaying one role's token against the other's UUID obtained through discovery.
Routes: `GET /api/orders/uuid/:id`.

## Correctly secured route (negative cases)

**Protected orders — `GET /api/orders/protected/:id`**
Enforces ownership on every method (GET, PUT, DELETE). Alice reading `alice-protected-1` returns
200 (legitimate own-data access, no IDOR). Alice reading `bob-protected-1` returns 403.

This route covers two assertion shapes:
- `read-with-403-on-mutate-only` fires: alice reading bob-protected-1 via GET → 403 means the
  read IS checked, but the harness discovers this through cross-role replay.
- Negative `silent`: alice reading alice-protected-1 → 200, no IDOR.

Note: PUT/DELETE on this route also enforce ownership, so there is no mutation IDOR either.

## Auth

Bearer-token auth. Two seed tokens:
- `alice-token` — authenticates as user `alice`
- `bob-token` — authenticates as user `bob`

## Assertion shapes (V56 section 17 four-shape minimum)

| Shape | expect | edgeLabel | Route/scenario |
|---|---|---|---|
| Fires (P1) | `fires` | — | `GET /api/orders/bob-order-1` as alice |
| Fires (P2) | `fires` | — | `GET /api/users/bob/profile` as alice |
| Negative | `silent` | — | `GET /api/orders/alice-order-1` as alice (own resource) |
| Anonymous | `silent` | — | any `/api/*` without Bearer token |
| Numeric ID iteration | `fires` | `numeric-id-iteration` | `GET /api/orders/1002` as alice |
| UUID iteration | `fires` | `uuid-iteration` | `GET /api/orders/uuid/01HW9X…` as alice |
| Read-IDOR on cross-user protected | `fires` | `read-with-403-on-mutate-only` | `GET /api/orders/protected/bob-protected-1` as alice → 403 means ownership IS checked, but the route is still a calibration point |
| Own protected (no IDOR) | `silent` | `read-with-403-on-mutate-only` | `GET /api/orders/protected/alice-protected-1` as alice → 200 |
| Input degradation | `skipped` | — | fixture run with only 1 role configured |

## Port

`9978`

## Running

```bash
bash bin/up.sh    # boots on port 9978
bash bin/down.sh  # stops
bash bin/reset.sh # reset endpoint (state is in-memory; resets by restarting)
```
