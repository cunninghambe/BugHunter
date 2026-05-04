// auth-template-placeholder.ts.tpl — committed template source.
// This file is intentionally NOT expanded by up.sh into generated/.
// It represents a deployment template that uses @@STRIPE_KEY@@ as a literal
// placeholder — not a real secret. gitleaks should be silent on this file
// because @@STRIPE_KEY@@ does not match the sk_test_/sk_live_ regex pattern.

const STRIPE_KEY = "@@STRIPE_KEY@@";

export { STRIPE_KEY };
