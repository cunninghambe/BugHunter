import { describe, it, expect } from 'vitest';
import { parseSnapshot, resolveSelectorInSnapshot } from '../src/adapters/browser-mcp-snapshot.js';

const SIGN_IN_SNAPSHOT = `
- generic [e1]:
  - banner [e2]:
    - link "Healthy Spoon" [ref=e3]
  - main [e4]:
    - heading "Sign in" [level=1] [ref=e5]
    - textbox "Email" [ref=e6]
    - textbox "Password" [type=password] [ref=e7]
    - button "Sign in" [ref=e8]
    - link "Forgot password" [ref=e9]
`;

const PRODUCT_LIST_SNAPSHOT = `
- generic [e1]:
  - main [e2]:
    - heading "Products" [level=1] [ref=e3]
    - button "Add Product" [aria-label="Add Product"] [ref=e4]
    - list [e5]:
      - listitem [e6]:
        - link "Widget A" [ref=e7]
        - button "Edit" [aria-label="Edit Widget A"] [ref=e8]
      - listitem [e9]:
        - link "Widget B" [ref=e10]
        - button "Edit" [aria-label="Edit Widget B"] [ref=e11]
`;

const DASHBOARD_SNAPSHOT = `
- generic [e1]:
  - navigation [e2]:
    - link "Dashboard" [ref=e3]
    - link "Orders" [ref=e4]
    - link "Products" [ref=e5]
  - main [e6]:
    - heading "Welcome" [level=1] [ref=e7]
    - textbox "Search" [placeholder="Search orders..."] [ref=e8]
    - button "Submit" [data-testid="submit-btn"] [ref=e9]
`;

describe('parseSnapshot — sign-in form', () => {
  it('parses all 9 lines with refs (including containers)', () => {
    const nodes = parseSnapshot(SIGN_IN_SNAPSHOT);
    // e1–e9 all have ref tokens (containers use [eN], interactives use [ref=eN])
    expect(nodes.length).toBe(9);
  });

  it('extracts role and name', () => {
    const nodes = parseSnapshot(SIGN_IN_SNAPSHOT);
    const emailBox = nodes.find(n => n.ref === 'e6');
    expect(emailBox?.role).toBe('textbox');
    expect(emailBox?.name).toBe('Email');
  });

  it('extracts attrs like type=password', () => {
    const nodes = parseSnapshot(SIGN_IN_SNAPSHOT);
    const pwd = nodes.find(n => n.ref === 'e7');
    expect(pwd?.attrs?.['type']).toBe('password');
  });

  it('parses both [eN] and [ref=eN] forms', () => {
    const nodes = parseSnapshot(SIGN_IN_SNAPSHOT);
    // e1 uses bare [e1], e3 uses [ref=e3] form
    const e1 = nodes.find(n => n.ref === 'e1');
    const e3 = nodes.find(n => n.ref === 'e3');
    expect(e1).toBeDefined();
    expect(e3).toBeDefined();
  });
});

describe('parseSnapshot — product list + dashboard', () => {
  it('parses product list correctly', () => {
    const nodes = parseSnapshot(PRODUCT_LIST_SNAPSHOT);
    expect(nodes.length).toBeGreaterThanOrEqual(8);
  });

  it('parses dashboard correctly', () => {
    const nodes = parseSnapshot(DASHBOARD_SNAPSHOT);
    expect(nodes.length).toBeGreaterThanOrEqual(7);
  });
});

describe('resolveSelectorInSnapshot — resolution algorithm (§3.7)', () => {
  const nodes = parseSnapshot(SIGN_IN_SNAPSHOT);
  const productNodes = parseSnapshot(PRODUCT_LIST_SNAPSHOT);
  const dashNodes = parseSnapshot(DASHBOARD_SNAPSHOT);

  it('Step 1: already a ref returns it directly', () => {
    expect(resolveSelectorInSnapshot('e6', nodes)).toBe('e6');
  });

  it('Step 2: structured {role, name} resolves to first match', () => {
    const ref = resolveSelectorInSnapshot({ role: 'button', name: 'Sign in' }, nodes);
    expect(ref).toBe('e8');
  });

  it('Step 2: structured {role, name, nth?} resolves by nth among matching roles', () => {
    // Two "Edit" buttons in product list — same name, different nth
    const ref0 = resolveSelectorInSnapshot({ role: 'button', name: 'Edit', nth: 0 }, productNodes);
    const ref1 = resolveSelectorInSnapshot({ role: 'button', name: 'Edit', nth: 1 }, productNodes);
    expect(ref0).toBe('e8');
    expect(ref1).toBe('e11');
  });

  it('Step 3: #id selector returns null (no id attrs in snapshot)', () => {
    // Snapshot doesn't have id attrs — should return null to trigger evaluate fallback
    const ref = resolveSelectorInSnapshot('#email', nodes);
    expect(ref).toBeNull();
  });

  it('Step 4: tag[aria-label="X"] resolves via aria-label match on name', () => {
    const ref = resolveSelectorInSnapshot('button[aria-label="Add Product"]', productNodes);
    expect(ref).toBe('e4');
  });

  it('Step 4: tag[data-testid="Y"] resolves', () => {
    const ref = resolveSelectorInSnapshot('button[data-testid="submit-btn"]', dashNodes);
    expect(ref).toBe('e9');
  });

  it('Step 6: body resolves to the generic root node e1', () => {
    const ref = resolveSelectorInSnapshot('body', nodes);
    expect(ref).toBe('e1');
  });

  it('Step 6: plain tag resolves to first match', () => {
    const ref = resolveSelectorInSnapshot('button', nodes);
    expect(ref).toBe('e8');
  });

  it('Step 7: .class selector returns null (needs evaluate fallback)', () => {
    const ref = resolveSelectorInSnapshot('.product-card', nodes);
    expect(ref).toBeNull();
  });

  it('Step 7: :nth-of-type returns null (needs evaluate fallback)', () => {
    const ref = resolveSelectorInSnapshot('button:nth-of-type(2)', nodes);
    expect(ref).toBeNull();
  });
});
