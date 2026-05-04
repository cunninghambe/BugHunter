# auth-bypass-mini

BugHunter detector-calibration fixture for `auth_bypass_via_unauthed_route`.

## What's planted

| Route | Method | Expected auth | Actual auth | Plant # |
|-------|--------|--------------|-------------|---------|
| /api/admin/users | GET | admin session | none | P1 |
| /api/orders | GET | authenticated user | none | P2 |
| /api/users/:id/role/admin | POST | admin only | none (optional P3) | P3 |

The cross-user runner replays these routes as `anonymous` and observes 200 responses with non-empty bodies — which the detector classifies as `auth_bypass_via_unauthed_route`.

## Correctly-secured control route

`GET /api/me` returns 401 when no `Authorization` header is present. The detector must NOT fire on this route — confirming the fixture's silent path is also correct.

## Roles

`anonymous` and `admin`. The V53 multi-surface convention requires `anonymous` in the roles config so the cross-user runner can replay requests without credentials.

## Port

9976

## Surface

`api` — the cross-user phase replays API tool calls as anonymous to confirm bypass.

## Usage

```bash
bash bin/up.sh
# harness sends: GET /api/admin/users (anonymous) → expects 200 non-empty
# harness sends: GET /api/orders (anonymous) → expects 200 non-empty
# harness sends: GET /api/me (anonymous) → expects 401 (NOT a bypass)
bash bin/down.sh
```
