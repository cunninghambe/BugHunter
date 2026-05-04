# xss-mini

BugHunter detector-calibration fixture for `xss_reflected` (V56 spec section 17).

## What's planted

| Route | Method | Input | Reflected how | Plant type |
|-------|--------|-------|---------------|------------|
| /api/search | GET | `?q=` | Directly into `<p>` body — no escaping | Positive (fires) |
| /api/echo-safe | GET | `?msg=` | HTML-escaped (`&lt;script&gt;` etc.) | Negative (silent) |
| /api/link | GET | `?url=` | Directly into `<a href="">` attribute | Edge: attribute-context-vs-body |
| /api/greet | GET | `?name=` | Directly into `<div>` — receives both `<script>alert(1)</script>` and `<img src=x onerror=alert(1)>` payloads | Edge: script-tag-payload-vs-img-onerror |

## Test shapes (V56 section 17 four-shape minimum)

| Shape | Assertion | Route |
|-------|-----------|-------|
| Positive | `expect: "fires"` | /api/search |
| Negative | `expect: "silent"` | /api/echo-safe |
| Edge 1 | `expect: "fires"`, `edgeLabel: "attribute-context-vs-body"` | /api/link |
| Edge 2 | `expect: "fires"`, `edgeLabel: "script-tag-payload-vs-img-onerror"` | /api/greet |
| Degradation | `expect: "skipped"`, `reason: "fixture_unreachable"` | (no route — triggers when server is down/503) |

## Negative case detail

`GET /api/echo-safe?msg=<script>alert(1)</script>` returns:

```html
<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>
```

The HTML entities make the script tag inert. The detector must observe the escaped form and emit no cluster.

## Edge case detail

**attribute-context-vs-body** (`/api/link`): the same `javascript:alert(1)` or `"><script>alert(1)</script>` payload lands inside an `href` attribute rather than a text node. The signature the detector emits should differ from a plain body-reflection hit (different context indicator).

**script-tag-payload-vs-img-onerror** (`/api/greet`): the detector sends two payloads against the same route — `<script>alert(1)</script>` and `<img src=x onerror=alert(1)>`. Both reflect unescaped into the `<div>`. Both should fire, but the harness expects distinct `signaturePrefix` values demonstrating the detector distinguishes payload types.

## Degradation case detail

When the fixture server is unreachable (down, returning 503, or connection refused), the detector must emit `skipped` with `reason: "fixture_unreachable"` rather than a false-positive cluster or an uncaught error. The `expect: "skipped"` assertion verifies this contract.

## Port

9971

## Surface

`api` — payload injection via GET query parameters, HTTP response inspection.

## Usage

```bash
bash bin/up.sh
# detector sends: GET /api/search?q=<script>alert(1)</script> → expects fires
# detector sends: GET /api/echo-safe?msg=<script>alert(1)</script> → expects silent
# detector sends: GET /api/link?url=javascript:alert(1) → expects fires (attribute context)
# detector sends: GET /api/greet?name=<script>alert(1)</script> → expects fires (script-tag)
# detector sends: GET /api/greet?name=<img+src=x+onerror=alert(1)> → expects fires (img-onerror)
bash bin/down.sh
```
