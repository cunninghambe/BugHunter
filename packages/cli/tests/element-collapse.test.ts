import { describe, it, expect } from 'vitest';
import { collapseElements, elementCollapseSignature } from '../src/discovery/element-collapse.js';
import type { Element } from '../src/types.js';

function makeButton(i: number, override: Partial<Element> = {}): Element {
  return {
    tag: 'button',
    roleAttr: undefined,
    typeAttr: 'submit',
    testId: 'product-row:btn',
    ancestorStack: 'tr>td>div',
    selector: `button:nth-of-type(${i})`,
    disabled: false,
    ...override,
  };
}

describe('same-shape element collapsing', () => {
  it('50 buttons with the same signature collapse to 1 representative', () => {
    const buttons: Element[] = Array.from({ length: 50 }, (_, i) => makeButton(i + 1));
    const collapsed = collapseElements(buttons);
    expect(collapsed).toHaveLength(1);
    // The representative is the first one
    expect(collapsed[0].selector).toBe('button:nth-of-type(1)');
  });

  it('buttons with different typeAttr are distinct', () => {
    const b1 = makeButton(1, { typeAttr: 'submit' });
    const b2 = makeButton(2, { typeAttr: 'button' });
    const collapsed = collapseElements([b1, b2]);
    expect(collapsed).toHaveLength(2);
  });

  it('buttons with different testId prefix are distinct', () => {
    const b1 = makeButton(1, { testId: 'product-row:edit' });
    const b2 = makeButton(2, { testId: 'order-row:edit' });
    const collapsed = collapseElements([b1, b2]);
    expect(collapsed).toHaveLength(2);
  });

  it('buttons with different ancestor stack are distinct', () => {
    const b1 = makeButton(1, { ancestorStack: 'tr>td>div' });
    const b2 = makeButton(2, { ancestorStack: 'nav>ul>li' });
    const collapsed = collapseElements([b1, b2]);
    expect(collapsed).toHaveLength(2);
  });

  it('testId prefix stops at first colon', () => {
    const b1 = makeButton(1, { testId: 'product-row:edit' });
    const b2 = makeButton(2, { testId: 'product-row:delete' });
    // Same prefix "product-row" — same signature
    const collapsed = collapseElements([b1, b2]);
    expect(collapsed).toHaveLength(1);
  });

  it('empty list stays empty', () => {
    expect(collapseElements([])).toHaveLength(0);
  });

  it('1 element passes through unchanged', () => {
    const el = makeButton(1);
    expect(collapseElements([el])).toHaveLength(1);
    expect(collapseElements([el])[0]).toEqual(el);
  });

  it('disabled elements are not in input to collapseElements (caller filters)', () => {
    const b1 = makeButton(1);
    const b2 = makeButton(2, { disabled: true });
    // disabled elements are passed through — caller should filter
    const collapsed = collapseElements([b1, b2]);
    // They share signature so collapse to 1 (disabled flag is not part of signature)
    expect(collapsed).toHaveLength(1);
  });
});
