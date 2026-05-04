# auth-bypass-mini

BugHunter detector-calibration fixture for `auth_bypass_via_unauthed_route`.

## What's planted

| Route | Method | Expected auth | Actual auth | Plant # |
|-------|--------|--------------|-------------|---------|
| /api/admin/users | GET | admin session | none | P1 |
| /api/orders | GET | authenticated user | none | P2 |
| /api/users/:id/role/admin | POST | admin only | none (optional P3) | P3 |

The cross-user runner replays these routes as `anonymous` and observes 200 responses with non-empty bodies — which the detector classifies as `auth_bypass_via_unauthed_route` at `critical` severity.

## V56.2 four-shape test minimum

`expected-clusters.jsonl` now covers all four required shapes:

| Shape | Route | expect | edgeLabel | severity |
|-------|-------|--------|-----------|----------|
| positive | /api/admin/users | fires | — | critical |
| positive | /api/orders | fires | — | critical |
| **negative** | /healthz | silent | — | — |
| **edge** | /api/me | silent | route-requires-auth-and-fails-correctly | — |
| **edge** | /api/items | fires | route-allows-anon-but-returns-empty | info |
| **input-degradation** | (any) | skipped | — | — |

## publicAllowList

`contract.json` declares a `publicAllowList` field listing routes that are intentionally unauthenticated and return no sensitive data. The detector must remain silent for these routes even when anonymous access returns 200. Current allowlist: `/healthz`, `/health`.

For V56.2 this is declarative-only (enforced by `expected-clusters.jsonl`). Harness integration lands in V56.3.

## Edge: route-requires-auth-and-fails-correctly

`GET /api/me` returns 401 when no `Authorization` header is present. The detector must remain silent — the auth check is working correctly and this is not a bypass.

## Edge: route-allows-anon-but-returns-empty

`GET /api/items` returns 200 with `{ items: [] }` for anonymous callers. The route filters by user identity server-side; anonymous gets nothing. This is not a confirmed exploit, but the detector fires at `info` severity as a potential issue for human review.

## Input degradation

When `contract.roles` does not include `"anonymous"`, the detector cannot replay requests without credentials and must emit `expect: "skipped"` with `reason: "no_anonymous_role"`. No finding is emitted.

## Roles

`anonymous` and `admin`. The V53 multi-surface convention requires `anonymous` in the roles config so the cross-user runner can replay requests without credentials.

## Port

9976

## Surface

`api` — the cross-user phase replays API tool calls as anonymous to confirm bypass.

## Usage

```bash
bash bin/up.sh
# harness sends: GET /api/admin/users (anonymous) → expects 200 non-empty → fires critical
# harness sends: GET /api/orders (anonymous) → expects 200 non-empty → fires critical
# harness sends: GET /healthz (anonymous) → expects 200, in publicAllowList → silent
# harness sends: GET /api/me (anonymous) → expects 401 → silent
# harness sends: GET /api/items (anonymous) → expects 200 empty → fires info
bash bin/down.sh
```
