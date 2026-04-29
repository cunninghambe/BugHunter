# SPEC — v0.18 "JWT-aware login verification"

**Status:** Draft 1 — ready for `@coder` assignment · **Author:** `@architect` (Opus, ultrathink) · **Date:** 2026-04-29 · **Predecessor:** v0.13 vision-baseline auth survival, PR #34 login robustness · **Sibling:** v0.17 multi-viewport.

This spec adds two new `successCheck` kinds to the SurfaceMCP browser-login plan so that JWT-bearer SPAs (auth state in localStorage / sessionStorage; no session cookie; client-side router post-auth redirect) can be reliably verified as "logged in." The Aspectv3 smoke surfaced this: login completes successfully (200 from `/api/v1/auth/login`, JWT in `localStorage['auth-storage']`, SPA navigates `/login` → `/dashboard` via React Router), but the existing `verifySuccess` polls for cookies / URL-equality and times out → `browser_login_verification_failed` → vision baseline aborts → `authLostMidLoop: true`. The fix is small (~80 lines) but unblocks the entire post-login pipeline (vision, per-role tests, IDOR cross-user) on every JWT SPA we run.

---

## 1. Objective

Add two `successCheck` kinds to SurfaceMCP's `AuthConfigSchema` and BugHunter's browser-login `verifySuccess`:

| Kind | Verification signal |
|---|---|
| `localStorage` | A specific `localStorage` key is set to a non-empty value after login. Optional `tokenJsonPath` extracts a nested JWT (e.g. `auth-storage.state.token`). |
| `dom_signal` | A specific CSS selector is present in the DOM after login (proves the SPA rendered a post-auth view). |

Both are polled the same way as the existing `cookie` and `redirect` kinds. The Zod schema in SurfaceMCP gains the two new variants of the discriminated union; BugHunter's `verifySuccess` gains two new branches.

**In scope:**
- Two new `successCheck` kinds in SurfaceMCP `AuthConfigSchema`
- Matching `verifySuccess` branches in BugHunter `discovery/browser-login.ts`
- Aspectv3 reference config update demonstrating the `localStorage` kind
- Backward compatibility: existing `cookie` / `redirect` / `status` configs unchanged

**Out of scope (deferred):**
- sessionStorage support — same shape; trivial follow-up. Defer to v0.19 unless a real target needs it.
- IndexedDB token retrieval — niche; v0.20.
- Encrypted storage decoding — out of scope forever; user-config supplies the key path.
- Refresh-token rotation detection — that's an auth-flow finding, not a login verification signal.
- Auto-discovery of which storage key holds the JWT — the user must provide it; we are not running heuristics over the localStorage namespace.

**Acceptance target on Aspectv3:**
With `successCheck: { kind: 'localStorage', key: 'auth-storage' }` in `surfacemcp.config.json`, the next smoke produces:
- Owner browser-login completes with `verification_passed`
- `authLostMidLoop: false` in `summary.json.discovery.visionBaselineTelemetry`
- ≥ 1 vision call from the singleton tab
- 0 `browser_login_verification_failed` entries in `summary.json.skippedReasons`

---

## 2. Existing code map

### 2.1 Files you MUST read before writing any code

| File | Why |
|---|---|
| `/root/SurfaceMCP/src/config.ts` | `AuthConfigSchema` and `SuccessCheckSchema`. Add two variants to `SuccessCheckSchema`'s discriminated union. |
| `/root/SurfaceMCP/src/auth/describe-auth.ts` | The `buildDescribeAuth` builders for `form` and `nextauth` plans. Both already pass `successCheck` through unchanged — verify no extra plumbing is needed. |
| `/root/SurfaceMCP/src/auth/describe-auth.test.ts` | Pattern for unit-testing the schema. Mirror. |
| `/root/BugHunter/packages/cli/src/adapters/surface-mcp.ts` | `DescribeAuthResult` type — the SuccessCheck union it imports. Verify the union picks up the new kinds at the type level. |
| `/root/BugHunter/packages/cli/src/discovery/browser-login.ts` | `verifySuccess` (line ~280-330). Add two new `if/else` branches for the new kinds. |
| `/root/BugHunter/packages/cli/src/discovery/browser-login.test.ts` | Pattern for unit-testing `verifySuccess` against a mocked browser. Mirror with two new `describe` blocks. |
| `/root/Aspectv3/surfacemcp.config.json` | Reference config — update its `successCheck` block to demonstrate the new kind. |

### 2.2 Patterns to follow

- **Discriminated union extension.** Add to the existing `z.discriminatedUnion('kind', [...])`; don't fork.
- **Polling loop.** New branches use the SAME `Date.now() + verifyTimeoutMs` polling loop already in `verifySuccess`. Inter-poll sleep is the existing `verifyPollMs`.
- **Empty / null checks.** A `localStorage` key returning `null`, `''`, `'null'`, `'undefined'` is treated as not-yet-set. Real JWT tokens are JSON or 3-part dot-separated strings.
- **Discriminated-union returns.** `verifySuccess` already returns `LoginResult`; no shape change.

### 2.3 DO NOT

- Do **not** make `localStorage` / `dom_signal` kinds the new default. `cookie` stays default for next-auth, `status` for plain form auth.
- Do **not** auto-detect the localStorage key. User config supplies it; we trust it.
- Do **not** parse the JWT contents. We only verify "the token is present and non-empty." Token validity is the server's job; if the server gives us a token we trust it works.
- Do **not** add a runtime dep for JWT decoding. Native `string.split('.')` is enough if we ever need to peek at claims (we don't, for v0.18).
- Do **not** change BugHunter's `loginInBrowser` flow — only `verifySuccess`.

---

## 3. Schema additions

### 3.1 SurfaceMCP `SuccessCheckSchema` extension (`/root/SurfaceMCP/src/config.ts`)

Today (lines around 30-35):
```ts
const SuccessCheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('redirect'), to: z.string() }),
  z.object({ kind: z.literal('cookie'), name: z.string() }),
  z.object({ kind: z.literal('status'), code: z.number().int() }),
]);
```

v0.18 adds:
```ts
const SuccessCheckSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('redirect'), to: z.string() }),
  z.object({ kind: z.literal('cookie'), name: z.string() }),
  z.object({ kind: z.literal('status'), code: z.number().int() }),
  // v0.18: JWT-bearer SPA support
  z.object({
    kind: z.literal('localStorage'),
    key: z.string(),                                // e.g. 'auth-storage'
    tokenJsonPath: z.string().optional(),           // dotted path inside the JSON value, e.g. 'state.token'
    minLength: z.number().int().positive().optional(),  // default: 16 (rejects 'null', 'undefined', '')
  }),
  z.object({
    kind: z.literal('dom_signal'),
    selector: z.string(),                           // e.g. '[data-testid="user-menu"]'
  }),
]);
```

### 3.2 BugHunter type propagation

`packages/cli/src/adapters/surface-mcp.ts` imports `DescribeAuthResult` which transitively includes the SuccessCheck union. Verify TS picks up the new variants at the call site (TS error if not). Add a type-level test: `assertNever` exhaustiveness check in `verifySuccess` so future kinds force a compile error if unhandled.

---

## 4. `verifySuccess` extensions (`packages/cli/src/discovery/browser-login.ts`)

Insert two new branches into the polling loop (around line 295 area in current main):

```ts
} else if (plan.successCheck.kind === 'localStorage') {
  const sc = plan.successCheck;
  try {
    const result = await browser.evaluate(
      `(function(){
        var raw=localStorage.getItem(${JSON.stringify(sc.key)});
        if(raw===null||raw==='')return null;
        ${sc.tokenJsonPath ? `
        try{
          var obj=JSON.parse(raw);
          var path=${JSON.stringify(sc.tokenJsonPath)}.split('.');
          var v=obj;
          for(var i=0;i<path.length;i++){if(v==null)return null;v=v[path[i]];}
          return typeof v==='string'?v:null;
        }catch(e){return null;}
        ` : `return raw;`}
      })()`
    );
    const token = String(result.value ?? '');
    const minLen = sc.minLength ?? 16;
    if (token.length >= minLen && token !== 'null' && token !== 'undefined') {
      const cookies = await getCookies(browser, baseUrl);
      return { ok: true, cookies, finalUrl: currentUrl };
    }
  } catch { /* keep polling */ }
} else if (plan.successCheck.kind === 'dom_signal') {
  const sc = plan.successCheck;
  try {
    const result = await browser.evaluate(
      `document.querySelector(${JSON.stringify(sc.selector)})!==null`
    );
    if (result.value === true) {
      const cookies = await getCookies(browser, baseUrl);
      return { ok: true, cookies, finalUrl: currentUrl };
    }
  } catch { /* keep polling */ }
}
```

Cookies are still captured (even when empty) because downstream consumers (cross-user IDOR replay, header probe) read the cookie jar. JWT tokens stored in `localStorage` are NOT included in the cookie jar — that's correct; the SPA injects them via `Authorization: Bearer ...` headers on its fetches, which camofox preserves on subsequent navigations within the same context.

---

## 5. Edge cases

### EC-1. localStorage key exists but value is `'null'` (string literal)
Many libs (Zustand persist, redux-persist) write `'null'` for empty state. Reject. Min-length check (default 16) catches this.

### EC-2. localStorage value is JSON-wrapped, but tokenJsonPath is wrong
`JSON.parse` succeeds, but path traversal hits an undefined. Returns null → keep polling → eventually times out → `verification_failed` with detail mentioning the bad path. User adjusts config.

### EC-3. localStorage value isn't JSON, but tokenJsonPath is set
`JSON.parse` throws inside the try → return null → keep polling → eventually times out. User notices the misconfiguration via the `verification_failed` log.

### EC-4. dom_signal selector matches a placeholder (e.g., a hidden user-menu rendered before auth)
User-config issue, not ours. Document in the spec: pick a selector that ONLY exists post-auth (test-id is best).

### EC-5. localStorage key set BUT page is still on /login (because navigation hasn't fired)
Token presence is enough — return ok with `finalUrl` being whatever the URL is at that moment. The vision-baseline phase later navigates explicitly; it doesn't depend on post-login URL.

### EC-6. Two roles share a localStorage key but one is logged out
After role-A logout, the key is still set if logout doesn't clear it (Zustand persist often leaves the key with `state: { user: null }`). Mitigation: tokenJsonPath required for SPAs that don't clear the key on logout. Document.

### EC-7. minLength of 16 rejects a real but very short JWT
A real JWT is always 100+ chars (header.payload.signature, all base64). 16 is a safe floor. If a custom token format is shorter, set `minLength: <actual>` in config.

### EC-8. SPA stores JWT in cookies AND localStorage (belt-and-suspenders pattern)
User picks one; both work. Recommend cookie path because it survives reload cleanly, but localStorage is fine for SPAs that don't use cookies at all.

### EC-9. localStorage access blocked by CSP / sandbox
`browser.evaluate` throws → silent catch → keep polling → eventually times out. User sees `verification_failed` and switches to `dom_signal`.

---

## 6. Test plan

### 6.1 SurfaceMCP unit tests (`/root/SurfaceMCP/src/auth/describe-auth.test.ts`)

- `successCheck: { kind: 'localStorage', key: 'auth-storage' }` parses cleanly + round-trips through `buildDescribeAuth`.
- `successCheck: { kind: 'dom_signal', selector: '[data-testid="x"]' }` parses cleanly.
- `successCheck: { kind: 'localStorage' }` (missing `key`) fails Zod parse with a clear error.
- `successCheck: { kind: 'localStorage', key: '', tokenJsonPath: 'a.b' }` Zod parses OK (empty key allowed at parse; runtime returns null).
- The `cookie` / `redirect` / `status` paths are unchanged.

### 6.2 BugHunter unit tests (`packages/cli/src/discovery/browser-login.test.ts`)

- `verifySuccess` with `localStorage` kind: mock browser.evaluate returns the stored JSON; verify ok=true.
- `localStorage` kind, value too short → keeps polling → times out.
- `localStorage` kind with `tokenJsonPath`: nested object → extracts the token correctly.
- `localStorage` kind with `tokenJsonPath` missing intermediate key → polling continues until timeout.
- `dom_signal` kind: mock returns `true` → ok=true.
- `dom_signal` kind: mock returns `false` until 5th poll → ok=true after 5 polls.
- Existing `cookie` / `redirect` / `status` tests still pass.

### 6.3 Integration smoke (manual, on Aspectv3)

1. Update `/root/Aspectv3/surfacemcp.config.json`: change `successCheck` from `{"kind":"status","code":200}` to `{"kind":"localStorage","key":"auth-storage","tokenJsonPath":"state.token"}` (verify the actual Zustand persist key shape by reading `/root/Aspectv3/apps/web/src/stores/auth.store.ts`).
2. Restart SurfaceMCP for Aspectv3 (port 3107).
3. Re-smoke. Expected:
   - Owner browser-login completes, no `browser_login_verification_failed` skip.
   - `summary.json.discovery.visionBaselineTelemetry.authLostMidLoop === false`.
   - ≥ 1 vision call.

---

## 7. Negative requirements

- Do **not** make `localStorage` / `dom_signal` discoverable automatically.
- Do **not** decode the JWT (no claims inspection, no expiry check, no signature verification).
- Do **not** change `loginInBrowser`'s flow before `verifySuccess`.
- Do **not** swallow Zod parse errors silently — surface them to the user.
- Do **not** log the localStorage value at any level — it's a credential. Log only `key` and `length` for telemetry.

---

## 8. Task breakdown

| # | Task | Files | Deps |
|---|---|---|---|
| 1 | Extend `SuccessCheckSchema` Zod with two new variants | `/root/SurfaceMCP/src/config.ts` | none |
| 2 | Add Zod parsing tests for new variants | `/root/SurfaceMCP/src/auth/describe-auth.test.ts` | 1 |
| 3 | Add `localStorage` + `dom_signal` branches to `verifySuccess` | `packages/cli/src/discovery/browser-login.ts` | 1 |
| 4 | Add unit tests for the two new `verifySuccess` branches | `packages/cli/src/discovery/browser-login.test.ts` | 3 |
| 5 | TS exhaustiveness check (`assertNever` on the discriminated union) | `packages/cli/src/discovery/browser-login.ts` | 3 |
| 6 | Update Aspectv3 reference config + restart SurfaceMCP | `/root/Aspectv3/surfacemcp.config.json` | 1-3 |
| 7 | Manual smoke against Aspectv3 verifying acceptance criteria | (manual) | 6 |

---

## 9. Acceptance + done-when matrix

| Criterion | Verifier |
|---|---|
| All new SurfaceMCP unit tests pass | `npm test` in `/root/SurfaceMCP` |
| All new BugHunter unit tests pass | `npm test` in `/root/BugHunter` |
| `npx tsc --noEmit` clean in both repos | `tsc` |
| `npx eslint . --max-warnings 0` clean | `eslint` |
| Aspectv3 smoke reports `authLostMidLoop: false` | `jq '.discovery.visionBaselineTelemetry.authLostMidLoop' summary.json` |
| Aspectv3 smoke reports `vision.called >= 1` | `jq '.vision.called' summary.json` |
| Existing `cookie` / `redirect` / `status` configs continue to work without change | regression run |

---

## 10. Risks + escape hatches

- **Risk: localStorage key on Aspectv3 isn't `'auth-storage'`.** Mitigation: read `/root/Aspectv3/apps/web/src/stores/auth.store.ts` to confirm the exact Zustand persist key. The default Zustand persist key is the store name; `useAuthStore` would be `auth-storage`. Verify before shipping the smoke acceptance test.
- **Risk: localStorage write happens AFTER React Router navigates.** If the SPA navigates first, then writes the token, `verifySuccess`'s URL-change branch (status path) wouldn't fire either, but our `localStorage` poll catches it on the next iteration (default 500ms). Worst case: 500ms latency.
- **Risk: SPA uses a different storage abstraction (Pinia, MobX, etc.).** All major React/Vue/Svelte stores ultimately serialize to localStorage by default. If a target uses IndexedDB or sessionStorage, document and defer to v0.20.
- **Escape hatch:** existing `dom_signal` is the universal fallback. Any post-auth UI element that doesn't appear pre-auth works as a verification signal.

---

## 11. Killer-demo runbook (Aspectv3)

```bash
# 1. Confirm the Zustand persist key
grep -A 3 "persist(" /root/Aspectv3/apps/web/src/stores/auth.store.ts | head -10
# Expect to see: name: 'auth-storage' (or similar). Adjust config if different.

# 2. Update Aspectv3 SurfaceMCP config
# Change: "successCheck": { "kind": "status", "code": 200 }
# To:     "successCheck": { "kind": "localStorage", "key": "auth-storage", "tokenJsonPath": "state.token" }

# 3. Restart Aspectv3 SurfaceMCP
pkill -f "/root/SurfaceMCP/dist/cli/main.js serve" 2>/dev/null; sleep 2
cd /root/Aspectv3 && \
  ASPECT_ADMIN_EMAIL=admin@test.aspect.local ASPECT_ADMIN_PASSWORD=AdminTestPass123! \
  nohup node /root/SurfaceMCP/dist/cli/main.js serve > /tmp/aspect-surfacemcp.log 2>&1 & disown
sleep 6 && curl -sS http://127.0.0.1:3107/health

# 4. Re-smoke
cd /root/Aspectv3 && \
  ASPECT_ADMIN_EMAIL=admin@test.aspect.local ASPECT_ADMIN_PASSWORD=AdminTestPass123! \
  node /root/BugHunter/packages/cli/dist/cli/main.js run --max-bugs 200 --budget 2400000 --a11y --a11y-strict --seo

# 5. Verify
RUN=$(ls -t /root/Aspectv3/.bughunter/runs/ | head -1)
jq '.discovery.visionBaselineTelemetry, .vision' /root/Aspectv3/.bughunter/runs/$RUN/summary.json
```

Expected: `authLostMidLoop: false`, `vision.called >= 1`, vision baseline produces actual screenshots.

---

## 12. Open questions

1. **Should the `tokenJsonPath` be optional or required for `localStorage` kind?** Spec says optional — bare key works for plain string tokens. Required path adds friction for the common case.
2. **Should `dom_signal` also accept a presence-of-text condition?** Out of scope; CSS selector is sufficient for v0.18. If a target needs text-based signals, the user can use `:has-text()` via the existing parsePlaywrightHasText helper (BugHunter side only — SurfaceMCP doesn't need to know).
3. **Should we cache the localStorage value across the run?** No — `verifySuccess` runs once per role login; subsequent uses (cross-user replay, vision baseline) work via the browser session, not the captured token.
