// hover-only-affordance static detector (v0.41).
// Scans CSS with postcss AST walk; emits hover_only_affordance BugDetections.
// No browser involvement. No regex parsing.

import postcss from 'postcss';
import type { BugDetection } from '../../types.js';

// Matches interactive selectors: element types or common interactive classes/attributes.
// Note: CSS class selectors start with `.` (non-word char) so we can't use \b before them.
const INTERACTIVE_RE = /(?:^|[\s,>+~])(?:button|a|select|input)(?:\b|$)|\.btn\b|\.button\b|\[role=["']?button["']?\]|\[onclick\]/;

const INTERACTIVE_PROPS = new Set([
  'background-color', 'background', 'color', 'transform',
  'opacity', 'visibility', 'display', 'border-color', 'box-shadow',
]);

type HoverRule = { baseSelector: string; props: Set<string>; line: number };
type FocusRule = { baseSelector: string; props: Set<string> };

function stripsBase(selector: string): string {
  return selector
    .replace(/:hover\b/g, '')
    .replace(/:not\([^)]+\)/g, '')
    .trim();
}

function isInsideHoverMediaQuery(rule: postcss.Rule): boolean {
  let parent: postcss.Container | postcss.Document | undefined = rule.parent;
  while (parent !== undefined && parent.type !== 'root') {
    if (parent.type === 'atrule') {
      const params = (parent as postcss.AtRule).params.toLowerCase();
      if (params.includes('hover: hover') || params.includes('pointer: fine')) return true;
    }
    parent = (parent as postcss.Rule).parent;
  }
  return false;
}

function collectProps(rule: postcss.Rule): Set<string> {
  const props = new Set<string>();
  rule.walkDecls(d => { props.add(d.prop); });
  return props;
}

function interactiveProps(props: Set<string>): Set<string> {
  return new Set([...props].filter(p => INTERACTIVE_PROPS.has(p)));
}

export function scanCssForHoverOnly(cssText: string, source: string): BugDetection[] {
  const root = postcss.parse(cssText, { from: source });
  const hoverRules: HoverRule[] = [];
  const focusRules: FocusRule[] = [];

  root.walkRules(rule => {
    if (isInsideHoverMediaQuery(rule)) return;

    for (const selector of rule.selectors) {
      const trimmed = selector.trim();
      if (trimmed.includes(':hover')) {
        const base = stripsBase(trimmed);
        if (!INTERACTIVE_RE.test(base)) continue;
        const props = interactiveProps(collectProps(rule));
        // cursor-only exclusion: a rule with only cursor:pointer is intentional
        if (props.size === 0 || (props.size === 1 && props.has('cursor'))) continue;
        hoverRules.push({ baseSelector: base, props, line: rule.source?.start?.line ?? 0 });
      } else if (trimmed.includes(':focus') || trimmed.includes(':active')) {
        const base = trimmed
          .replace(/:focus\b|:active\b/g, '')
          .replace(/:not\([^)]+\)/g, '')
          .trim();
        const props = interactiveProps(collectProps(rule));
        focusRules.push({ baseSelector: base, props });
      }
    }
  });

  const detections: BugDetection[] = [];
  for (const h of hoverRules) {
    const hasFocusMatch = focusRules.some(
      f => f.baseSelector === h.baseSelector && [...h.props].some(p => f.props.has(p)),
    );
    if (hasFocusMatch) continue;
    detections.push({
      kind: 'hover_only_affordance',
      rootCause: `:hover styles on "${h.baseSelector}" with no :focus/:active equivalent (touch users see no feedback)`,
      pageRoute: '<static>',
      selectorClass: h.baseSelector.slice(0, 80),
      staticContext: {
        tool: 'hover-only-affordance',
        ruleId: 'hover-only-affordance',
        sourceFile: source,
        sourceLine: h.line,
      },
    });
  }
  return detections;
}
