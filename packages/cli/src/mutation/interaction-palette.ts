// v0.38 interaction palette planner — mints per-action and per-route interaction test cases.
// Per spec §4 and §9: additive (not multiplicative), happy-only, action-shape-gated.

import type { TestCase, InteractionPaletteVariant, InteractionPaletteVariantKind, BugHunterConfig, DiscoveredPage } from '../types.js';
import { createId } from '@paralleldrive/cuid2';

const PER_ACTION_INTERACTION_VARIANTS: ReadonlyArray<InteractionPaletteVariantKind> = [
  'drag_drop', 'paste', 'autofill', 'animation_mid_transition',
];
const PER_ROUTE_INTERACTION_VARIANTS: ReadonlyArray<InteractionPaletteVariantKind> = [
  'print', 'reduced_motion', 'forced_colors', 'dark_mode', 'zoom_200',
];
const ALL_INTERACTION_VARIANTS: ReadonlyArray<InteractionPaletteVariantKind> = [
  ...PER_ACTION_INTERACTION_VARIANTS,
  ...PER_ROUTE_INTERACTION_VARIANTS,
];

type SkipReason =
  | 'gate_predicate_false'
  | 'adapter_unsupported'
  | 'route_already_baselined'
  | 'action_shape_incompatible'
  | 'interaction_palette_cap';

export type InteractionPaletteSkip = {
  variantKind: InteractionPaletteVariantKind;
  reason: SkipReason;
};

export type MintResult = {
  cases: TestCase[];
  skips: InteractionPaletteSkip[];
};

// Default payloads for paste variants
const PASTE_PAYLOADS: Record<string, string> = {
  plain_text: 'hello world\n• bullet\n• another',
  word_html: '<!--StartFragment--><p class=MsoNormal>Word paste</p><!--EndFragment-->',
  excel_html: '<table><tr><td>A1</td><td>B1</td></tr></table>',
  styled_html_with_script: '<p style="color:red">Pre</p><script>window.__pasteFired=true</script><p>Post</p>',
};

const AUTOFILL_VALUES: Record<string, string> = {
  email: 'autofill@example.com',
  password: 'AutofillPass123!',
  cc: '4111111111111111',
  address: '123 Main St, Springfield',
};

/**
 * Mint interaction-palette test cases.
 *
 * Per-action variants attach only to palette==='happy' UI test cases.
 * Per-route variants run once per (route, role) pair as render-only cases.
 */
export function mintInteractionPaletteCases(
  baseCases: TestCase[],
  pages: DiscoveredPage[],
  config: BugHunterConfig,
  roles: string[],
): MintResult {
  const paletteCfg = config.interactionPalette;
  if (paletteCfg?.enabled !== true) return { cases: [], skips: [] };

  const maxTests = paletteCfg.maxTests ?? 300;
  const cases: TestCase[] = [];
  const skips: InteractionPaletteSkip[] = [];

  // Track per-route env-variant runs (key: `${pageRoute}|${role}|${variantKind}`)
  const routeBaselined = new Set<string>();

  // Per-action variants: only on happy palette UI cases (not xss_inject, not api)
  for (const tc of baseCases) {
    if (tc.action.via !== 'ui') continue;
    if (tc.palette !== 'happy') continue;
    if (tc.action.injectionNonce !== undefined) continue;

    for (const variantKind of PER_ACTION_INTERACTION_VARIANTS) {
      if (cases.length >= maxTests) {
        skips.push({ variantKind, reason: 'interaction_palette_cap' });
        continue;
      }

      if (!isActionCompatible(tc.action.kind, variantKind)) {
        skips.push({ variantKind, reason: 'action_shape_incompatible' });
        continue;
      }

      const variant = buildPerActionVariant(variantKind, tc.action.selector ?? '');
      if (variant === null) {
        skips.push({ variantKind, reason: 'action_shape_incompatible' });
        continue;
      }

      cases.push({
        ...tc,
        id: createId(),
        action: { ...tc.action, interactionPalette: variant },
        interactionPaletteKind: variantKind,
      });
    }
  }

  // Per-route env variants: once per (route, role)
  for (const role of roles) {
    for (const page of pages) {
      for (const variantKind of PER_ROUTE_INTERACTION_VARIANTS) {
        if (cases.length >= maxTests) {
          skips.push({ variantKind, reason: 'interaction_palette_cap' });
          continue;
        }

        const key = `${page.route}|${role}|${variantKind}`;
        if (routeBaselined.has(key)) {
          skips.push({ variantKind, reason: 'route_already_baselined' });
          continue;
        }
        routeBaselined.add(key);

        const variant = buildPerRouteVariant(variantKind);
        cases.push(makeRouteVariantCase(page, role, variant, baseCases));
      }
    }
  }

  return { cases, skips };
}

function isActionCompatible(actionKind: string, variantKind: InteractionPaletteVariantKind): boolean {
  switch (variantKind) {
    case 'drag_drop': return actionKind === 'click';
    case 'paste': return actionKind === 'fill' || actionKind === 'submit';
    case 'autofill': return actionKind === 'fill' || actionKind === 'submit';
    case 'animation_mid_transition': return actionKind === 'click' || actionKind === 'submit';
    default: return false;
  }
}

function buildPerActionVariant(
  variantKind: InteractionPaletteVariantKind,
  selector: string,
): InteractionPaletteVariant | null {
  switch (variantKind) {
    case 'drag_drop':
      return { kind: 'drag_drop', sourceMime: 'text/plain', payload: 'drag-payload', targetSelector: selector };
    case 'paste':
      return { kind: 'paste', source: 'plain_text', payload: PASTE_PAYLOADS['plain_text'] ?? '' };
    case 'autofill':
      return { kind: 'autofill', field: 'email', value: AUTOFILL_VALUES['email'] ?? '' };
    case 'animation_mid_transition':
      return { kind: 'animation_mid_transition', transitionTriggerSelector: selector, intercedingActionDelayMs: 100 };
    default:
      return null;
  }
}

function buildPerRouteVariant(variantKind: InteractionPaletteVariantKind): InteractionPaletteVariant {
  switch (variantKind) {
    case 'print': return { kind: 'print' };
    case 'reduced_motion': return { kind: 'reduced_motion' };
    case 'forced_colors': return { kind: 'forced_colors' };
    case 'dark_mode': return { kind: 'dark_mode' };
    case 'zoom_200': return { kind: 'zoom_200', zoomFactor: 2.0 };
    default:
      return { kind: 'print' };
  }
}

function makeRouteVariantCase(
  page: DiscoveredPage,
  role: string,
  variant: InteractionPaletteVariant,
  baseCases: TestCase[],
): TestCase {
  const runId = baseCases.find(tc => tc.page === page.route)?.runId ?? 'run';
  const stateCtx = page.kind === 'state' ? page.stateContext : undefined;
  return {
    id: createId(),
    runId,
    role,
    page: page.route,
    action: {
      kind: 'render',
      via: 'ui',
      expectedOutcome: 'success',
      palette: 'happy',
      interactionPalette: variant,
    },
    expectedOutcome: 'success',
    palette: 'happy',
    interactionPaletteKind: variant.kind,
    stateContext: stateCtx,
  };
}

// Export for use in tests
export { ALL_INTERACTION_VARIANTS, PER_ACTION_INTERACTION_VARIANTS, PER_ROUTE_INTERACTION_VARIANTS };