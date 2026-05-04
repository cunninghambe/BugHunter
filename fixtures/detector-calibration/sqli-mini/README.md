# sqli-mini — SQL Injection Calibration Fixture

Minimal Node.js app with three SQL injection plants for `sql_injection` detector calibration.
Uses SQLite via `better-sqlite3` with a pre-seeded in-memory database.

## Planted bugs

| Plant | Endpoint | Method | Description |
|-------|----------|--------|-------------|
| P1 | `GET /api/search?q=` | GET | Concatenates `q` into `SELECT * FROM tasks WHERE title LIKE '%<q>%'` |
| P2 | `GET /api/admin/reports?filter=` | GET | Concatenates `filter` into `SELECT * FROM reports WHERE filter = '<filter>'` |
| P3 | `GET /api/tasks?label=` | GET | Concatenates `label` into `SELECT * FROM tasks WHERE label = '<label>'` |

All three plants use direct string interpolation into SQL queries. Error-based injection is detectable: SQLite error messages containing the payload text are returned in 500 responses.

## Port

`9972` — declared in `contract.json`.

## Surfaces

API only (`surface: 'api'`). No frontend required — the detector probes HTTP endpoints directly.

## Database

In-memory SQLite. Tables: `tasks` (id, title, label) and `reports` (id, name, filter). Pre-seeded with 3 task rows and 2 report rows.

## Reset

`POST /__bughunter_reset` closes the current database and creates a fresh in-memory instance with seed data. The `bin/reset.sh` script calls this endpoint.

## Dependencies

Requires `better-sqlite3`. The `bin/up.sh` script runs `npm install` in `app/` if `node_modules` is absent.
