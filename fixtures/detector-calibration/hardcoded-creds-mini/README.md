# hardcoded-creds-mini

Minimal fixture for the `hardcoded_credentials_in_source` detector. Expanded to the 4-shape test minimum per V56 spec section 17.

## Shapes covered

| # | Shape | File | Secret type | Expect |
|---|-------|------|-------------|--------|
| 1 | fires | `generated/src/lib/auth.ts` | Stripe secret key + AWS access key (hardcoded) | fires |
| 2 | silent (negative) | `generated/src/lib/auth-safe.ts` | `process.env.STRIPE_KEY` indirection | silent |
| 3 | fires (edge) | `generated/src/lib/auth-comment.ts` | Stripe key in `// example:` comment | fires — `edgeLabel: stripe-test-key-in-comment` |
| 4 | silent (edge) | `templates/auth-template-placeholder.ts.tpl` | `@@STRIPE_KEY@@` placeholder | silent — `edgeLabel: template-with-placeholder` |
| 5 | skipped | n/a | `generated/` missing (fixture not built) | skipped — `reason: fixture_not_built` |

## Shape rationale

- **Negative**: `process.env.STRIPE_KEY` is the proper pattern. The detector must not flag env-var indirection.
- **Comment edge**: gitleaks treats all source text — including `//` comments — as scannable. A key in a comment is still a leak.
- **Template edge**: `@@STRIPE_KEY@@` is a deployment template placeholder; it does not match the `sk_test_`/`sk_live_` regex. The detector must be silent.
- **Degradation**: when `bin/up.sh` has not been run the `generated/` dir is absent. The harness skips rather than errors.

## What's planted

| # | File | Secret type | Value pattern |
|---|------|-------------|---------------|
| P1 | `generated/src/lib/auth.ts` | Stripe secret key | `sk_test_51N...` (canonical gitleaks fixture format) |
| P2 | `generated/src/lib/auth.ts` | AWS access key ID | `AKIAIOSFODNN7EXAMPLE` (canonical gitleaks test string) |
| P3 | `generated/src/lib/auth-comment.ts` | Stripe secret key | `sk_test_51N...` in a source comment |

## GitHub push-protection strategy

The planted credential strings are **never committed**. The approach:

1. `templates/auth.ts.tpl` and `templates/auth-comment.ts.tpl` — committed, contain `@@STRIPE_KEY@@` and `@@AWS_ACCESS_KEY@@` placeholders (not real patterns; GitHub scanner does not flag template placeholders).
2. `templates/auth-safe.ts.tpl` — committed, contains only `process.env.STRIPE_KEY` (no real secret).
3. `templates/auth-template-placeholder.ts.tpl` — committed, contains `@@STRIPE_KEY@@` literal (also not flagged by GitHub push-protection; it's not a real key pattern). Scanned directly by gitleaks to verify the placeholder is silent.
4. `bin/up.sh` — generates `generated/src/lib/auth.ts` and `generated/src/lib/auth-comment.ts` at test-time by substituting real credential strings into the templates.
5. `generated/` — listed in this fixture's `.gitignore`; the generated files are local-only.

## Surface

`static-source` — no server is started. The harness runs gitleaks against the generated directory tree and against the committed `templates/` directory.

## Running

```bash
bash bin/up.sh     # generates credential files in generated/
bash bin/reset.sh  # regenerates (idempotent)
bash bin/down.sh   # removes generated/
```

After `up.sh`, verify:
```bash
cat generated/src/lib/auth.ts         # contains sk_test_ and AKIA keys
cat generated/src/lib/auth-safe.ts    # contains only process.env.STRIPE_KEY
cat generated/src/lib/auth-comment.ts # contains sk_test_ in a comment
```
