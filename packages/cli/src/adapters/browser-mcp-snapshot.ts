// Pure snapshot parser and selector→ref resolver for the camofox a11y tree.
// No I/O. No side effects. All functions are pure.

export type SnapshotNode = {
  ref: string;                    // 'e3'
  role: string;                   // 'button', 'link', 'textbox', etc.
  name?: string;                  // accessible name from quoted string
  attrs: Record<string, string>;  // 'level', 'type', 'disabled', 'id', etc.
  raw: string;                    // the original line, for diagnostics
};

// Structured selector form for click/type overloads.
export type StructuredSelector = {
  role: string;
  name?: string;
  nth?: number;
};

export function isStructuredSelector(s: unknown): s is StructuredSelector {
  return typeof s === 'object' && s !== null && 'role' in s;
}

/**
 * Parse a camofox/Playwright a11y snapshot string into SnapshotNode[].
 * Lines without a ref token are skipped. Both [eN] and [ref=eN] forms accepted.
 */
export function parseSnapshot(snapshot: string): SnapshotNode[] {
  const nodes: SnapshotNode[] = [];
  for (const rawLine of snapshot.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    // Extract ref: either [ref=eN] or trailing [eN]
    const refMatch = /\bref=(e\d+)\b/.exec(line) ?? /\[(e\d+)\]/.exec(line);
    if (!refMatch) continue;
    const ref = refMatch[1];

    // Role is the first word (stripping leading "- ")
    const withoutDash = line.replace(/^[\s-]+/, '');
    const roleMatch = /^(\w+)/.exec(withoutDash);
    const role = roleMatch?.[1]?.toLowerCase() ?? 'unknown';

    // Accessible name: first quoted substring
    const nameMatch = /"([^"]*)"/.exec(line);
    const name = nameMatch?.[1];

    // Attribute pairs [k=v] (excluding ref=eN). Strip surrounding quotes from value.
    const attrs: Record<string, string> = {};
    const attrPattern = /\[([\w-]+)=([^\]]+)\]/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrPattern.exec(line)) !== null) {
      const key = attrMatch[1];
      const rawVal = attrMatch[2];
      const val = rawVal.replace(/^["']|["']$/g, '');
      if (key !== 'ref') attrs[key] = val;
    }

    nodes.push({ ref, role, name, attrs, raw: rawLine });
  }
  return nodes;
}

/**
 * Resolve a CSS-style selector (or structured object) to a camofox ref string.
 * Returns null if resolution requires a DOM evaluate fallback (steps 5, 7).
 *
 * Steps 1–4 and 6: pure snapshot walk. Returns ref or null.
 * The caller is responsible for step 5 (evaluate fallback) and re-snapshot.
 */
export function resolveSelectorInSnapshot(
  selector: string | StructuredSelector,
  nodes: SnapshotNode[],
): string | null {
  // Step 1: already a ref
  if (typeof selector === 'string' && /^e\d+$/.test(selector)) {
    return selector;
  }

  // Step 2: structured {role, name?, nth?}
  if (isStructuredSelector(selector)) {
    return resolveStructured(selector, nodes);
  }

  // Steps 3–8 for string selectors
  return resolveStringSelector(selector, nodes);
}

function resolveStructured(sel: StructuredSelector, nodes: SnapshotNode[]): string | null {
  const matches = nodes.filter(n => {
    if (n.role !== sel.role.toLowerCase()) return false;
    if (sel.name !== undefined) {
      return (n.name ?? '').toLowerCase() === sel.name.toLowerCase();
    }
    return true;
  });
  const idx = sel.nth ?? 0;
  return matches[idx]?.ref ?? null;
}

/**
 * Parse Playwright's `tag:has-text("text")` extension into {tag, text}.
 * Accepts double-quote and single-quote forms. Returns null if the input
 * does not match the expected shape.
 *
 * Pure function. No I/O.
 */
export function parsePlaywrightHasText(
  selector: string
): { tag: string; text: string } | null {
  const dq = /^(\w+):has-text\("([^"]+)"\)$/.exec(selector);
  if (dq) return { tag: dq[1], text: dq[2] };
  const sq = /^(\w+):has-text\('([^']+)'\)$/.exec(selector);
  if (sq) return { tag: sq[1], text: sq[2] };
  return null;
}

function resolveHasText(tag: string, text: string, nodes: SnapshotNode[]): string | null {
  const lowerTag = tag.toLowerCase();
  const lowerText = text.toLowerCase();
  const found = nodes.find(
    n => n.role === lowerTag && (n.name ?? '').toLowerCase().includes(lowerText)
  );
  return found?.ref ?? null; // null signals evaluate fallback
}

function resolveStringSelector(selector: string, nodes: SnapshotNode[]): string | null {
  // Step 7: .class or :nth-of-type → needs DOM evaluate
  if (selector.startsWith('.') || selector.includes(':nth-of-type(')) {
    return null; // signal evaluate fallback
  }

  // Step 3: #id selector
  if (selector.startsWith('#')) {
    const id = selector.slice(1);
    const found = nodes.find(n => n.attrs['id'] === id);
    return found?.ref ?? null; // null signals evaluate fallback
  }

  // Step 4: tag[attr="value"] selector
  const attrSelectorMatch = /^(\w+)\[([\w-]+)="([^"]*)"\]$/.exec(selector);
  if (attrSelectorMatch) {
    const [, tag, attr, value] = attrSelectorMatch;
    return resolveAttrSelector(tag, attr, value, nodes);
  }

  // Step 6: plain tag selector
  if (/^\w+$/.test(selector)) {
    return resolvePlainTag(selector, nodes);
  }

  // Playwright :has-text() extension
  const hasText = parsePlaywrightHasText(selector);
  if (hasText) {
    return resolveHasText(hasText.tag, hasText.text, nodes);
  }

  // Unknown format — signal evaluate fallback
  return null;
}

function resolveAttrSelector(tag: string, attr: string, value: string, nodes: SnapshotNode[]): string | null {
  const found = nodes.find(n => {
    if (n.role !== tag.toLowerCase()) return false;
    // aria-label and data-testid can match accessible name
    if (attr === 'aria-label' || attr === 'data-testid') {
      return (n.name ?? '').toLowerCase() === value.toLowerCase() || n.attrs[attr] === value;
    }
    return n.attrs[attr] === value;
  });
  return found?.ref ?? null; // null signals evaluate fallback
}

function resolvePlainTag(tag: string, nodes: SnapshotNode[]): string | null {
  // Special case: body → generic/root node
  if (tag === 'body') {
    const root = nodes.find(n => n.role === 'generic' || n.role === 'root');
    return root?.ref ?? null;
  }
  const found = nodes.find(n => n.role === tag.toLowerCase());
  return found?.ref ?? null;
}

/**
 * After an evaluate fallback returns HTML, re-walk a fresh snapshot to find
 * the element by extracting accessible name candidates from the HTML string.
 */
export function resolveByHtml(
  html: string,
  tag: string,
  nodes: SnapshotNode[],
): string | null {
  // Extract candidate names from html attributes
  const candidates: string[] = [];
  const ariaLabel = /aria-label="([^"]*)"/.exec(html)?.[1];
  const placeholder = /placeholder="([^"]*)"/.exec(html)?.[1];
  const title = /title="([^"]*)"/.exec(html)?.[1];
  const alt = /alt="([^"]*)"/.exec(html)?.[1];
  // Text content: strip tags, take first 80 chars
  const textContent = html.replace(/<[^>]+>/g, '').trim().slice(0, 80);

  if (ariaLabel) candidates.push(ariaLabel);
  if (placeholder) candidates.push(placeholder);
  if (title) candidates.push(title);
  if (alt) candidates.push(alt);
  if (textContent) candidates.push(textContent);

  const roleToMatch = tag.toLowerCase();

  for (const candidate of candidates) {
    if (!candidate) continue;
    const found = nodes.find(n => {
      const roleMatch = roleToMatch === 'div' || n.role === roleToMatch;
      return roleMatch && (n.name ?? '').toLowerCase().includes(candidate.toLowerCase());
    });
    if (found) return found.ref;
  }
  return null;
}

/** Direction union mapping — public 'up'|'down' to camofox extended enum */
export function toCamofoxScrollDirection(
  direction: 'up' | 'down'
): 'up' | 'down' | 'left' | 'right' {
  return direction; // 'up'|'down' pass through; 'left'|'right' reserved for future
}
