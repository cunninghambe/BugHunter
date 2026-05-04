# xss-mini — Reflected XSS Calibration Fixture

Minimal Express app with three reflected XSS plants for `xss_reflected` detector calibration.

## Planted bugs

| Plant | Endpoint | Method | Description |
|-------|----------|--------|-------------|
| P1 | `GET /api/echo?msg=` | GET | Reflects raw `msg` query param directly into `<p>` tag — no encoding |
| P2 | `GET /api/search?q=` | GET | Reflects raw `q` query param into a `<div>` HTML snippet |
| P3 | `POST /api/comments` + `GET /api/comments` | POST/GET | Stores `comment` body field; GET handler returns stored values inline in `<li>` tags |

All three plants pass user input directly into HTML responses without HTML entity encoding or sanitization.

## Port

`9971` — declared in `contract.json`.

## Surfaces

API only (`surface: 'api'`). No frontend required — the detector probes HTTP endpoints directly.

## Reset

`POST /__bughunter_reset` clears the in-memory comment store. The `bin/reset.sh` script calls this endpoint.

## Why no dependencies

The server uses only Node.js built-ins (`http`, `url`) so no `npm install` is needed before running.
