// v0.42: template resolution with safe arithmetic.
// Resolves {{key}} placeholders in order: extract > before.store > runtime context.

export type TemplateContext = {
  extract?: Record<string, unknown>;
  beforeStore?: Record<string, unknown>;
  runtime?: Record<string, unknown>;
};

/**
 * Resolve all {{key}} placeholders in a string using the given context.
 * Arithmetic expressions like {{before.totalCount + 1}} are evaluated with tryArithmetic.
 * Throws with code 'invariant_template_invalid' if any placeholder cannot be resolved.
 */
export function resolveTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, expr: string) => {
    const trimmed = expr.trim();
    const value = resolveExpr(trimmed, ctx);
    if (value === undefined) {
      throw Object.assign(new Error(`invariant_template_invalid: cannot resolve '${trimmed}'`), { code: 'invariant_template_invalid' });
    }
    return String(value);
  });
}

/**
 * Same as resolveTemplate but for unknown values (not just strings).
 * Returns a resolved value or throws.
 */
export function resolveValue(value: unknown, ctx: TemplateContext): unknown {
  if (typeof value === 'string') {
    // Only process templates that contain {{...}}
    if (value.includes('{{')) return resolveTemplate(value, ctx);
    return value;
  }
  return value;
}

function resolveExpr(expr: string, ctx: TemplateContext): unknown {
  // Try arithmetic first: detect +, -, *, / operators between terms
  const arithmetic = tryArithmetic(expr, ctx);
  if (arithmetic !== undefined) return arithmetic;

  // Try direct lookup
  return lookupKey(expr, ctx);
}

function lookupKey(key: string, ctx: TemplateContext): unknown {
  // Priority: extract > before.store (prefixed with 'before.') > runtime
  if (ctx.extract !== undefined && key in ctx.extract) return ctx.extract[key];

  if (key.startsWith('before.') && ctx.beforeStore !== undefined) {
    const subKey = key.slice('before.'.length);
    if (subKey in ctx.beforeStore) return ctx.beforeStore[subKey];
  }

  if (ctx.runtime !== undefined && key in ctx.runtime) return ctx.runtime[key];

  return undefined;
}

/**
 * Safe arithmetic: handles `term op term` patterns where terms are numeric literals
 * or context keys, and op is +, -, *, /.
 * Returns the computed number, or undefined if the expression isn't arithmetic.
 * Throws if the expression looks arithmetic but operands are non-numeric.
 */
function tryArithmetic(expr: string, ctx: TemplateContext): number | undefined {
  // Match: <term> <op> <term> where op is +, -, *, /
  const match = expr.match(/^(.+?)\s*([+\-*/])\s*(.+)$/);
  if (match === null) return undefined;

  const [, leftStr, op, rightStr] = match;
  const left = resolveNumericTerm(leftStr.trim(), ctx);
  const right = resolveNumericTerm(rightStr.trim(), ctx);

  if (left === undefined || right === undefined) return undefined;

  switch (op) {
    case '+': return left + right;
    case '-': return left - right;
    case '*': return left * right;
    case '/':
      if (right === 0) throw new Error('invariant_template_invalid: division by zero');
      return left / right;
    default:
      return undefined;
  }
}

function resolveNumericTerm(term: string, ctx: TemplateContext): number | undefined {
  // Numeric literal
  const n = Number(term);
  if (!Number.isNaN(n)) return n;

  // Context key
  const val = lookupKey(term, ctx);
  if (val === undefined) return undefined;
  const num = Number(val);
  if (Number.isNaN(num)) return undefined;
  return num;
}
