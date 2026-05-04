# vuln-dep-mini

BugHunter detector-calibration fixture for `vulnerable_dependency_high`.

## What's planted

| Package | Version | CVEs |
|---------|---------|------|
| lodash | 4.17.4 | CVE-2019-10744 (prototype pollution), CVE-2020-8203 (prototype pollution) |
| axios | 0.21.0 | CVE-2021-3749 (ReDoS), CVE-2020-28168 (SSRF) |

Both packages have **high** or **critical** severity advisories in the npm registry advisory database.

## Intentional vulnerable versions

**This fixture intentionally pins vulnerable package versions.** The purpose is to calibrate the `vulnerable_dependency_high` detector: when `npm audit --json` is run against `app/`, it must emit advisories for lodash and axios.

Dependabot alerts on this fixture's branch are expected. Do not bump these versions — they are the plants.

## Surface

`static-source` — no server runs. The harness executor calls `npm audit --json` against the `app/` directory after `bin/up.sh` runs `npm install`.

## Port

None (null). `up.sh` only runs `npm install` to materialise `package-lock.json`.

## Usage

```bash
bash bin/up.sh
# harness then calls: npm audit --json in app/
bash bin/down.sh  # no-op
```
