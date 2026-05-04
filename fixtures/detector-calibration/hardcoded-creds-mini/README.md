# hardcoded-creds-mini

Minimal fixture for the `hardcoded_credentials_in_source` detector.

## What's planted

| # | File | Secret type | Value pattern |
|---|------|-------------|---------------|
| P1 | `generated/src/lib/auth.ts` | Stripe secret key | `sk_test_51N...` (canonical gitleaks fixture format) |
| P2 | `generated/src/lib/auth.ts` | AWS access key ID | `AKIAIOSFODNN7EXAMPLE` (canonical gitleaks test string) |

## GitHub push-protection strategy

The planted credential strings are **never committed**. The approach:

1. `templates/auth.ts.tpl` — committed, contains `@@STRIPE_KEY@@` and `@@AWS_ACCESS_KEY@@` placeholders (not real patterns; GitHub scanner does not flag template placeholders).
2. `bin/up.sh` — generates `generated/src/lib/auth.ts` at test-time by substituting real credential strings into the template.
3. `generated/` — listed in this fixture's `.gitignore`; the generated files are local-only.
4. gitleaks is run against `generated/` (declared in `contract.json` as `"scanTarget": "generated/"`), not against the committed source.

This means the fixture produces real gitleaks hits without ever committing anything that GitHub push-protection would flag.

## Surface

`static-source` — no server is started. The harness runs gitleaks against the generated directory tree.

## Running

```bash
bash bin/up.sh     # generates credential files in generated/
bash bin/reset.sh  # regenerates (idempotent)
bash bin/down.sh   # removes generated/
```

After `up.sh`, verify:
```bash
cat generated/src/lib/auth.ts   # should contain STRIPE_KEY and AWS_ACCESS_KEY
```
