import { describe, it, expect } from 'vitest';
import { scanCssForHoverOnly } from './hover-only-affordance.js';

describe('hover-only-affordance scanner', () => {
  it('emits a detection when a button has :hover but no :focus', async () => {
    const css = `
      .btn:hover { background-color: blue; }
    `;
    const result = await scanCssForHoverOnly(css, 'test.css');
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe('hover_only_affordance');
    expect(result[0].selectorClass).toContain('.btn');
  });

  it('does not emit when :focus is present with matching property', async () => {
    const css = `
      .btn:hover { background-color: blue; }
      .btn:focus { background-color: blue; }
    `;
    const result = await scanCssForHoverOnly(css, 'test.css');
    expect(result).toHaveLength(0);
  });

  it('does not emit for :active match', async () => {
    const css = `
      a:hover { color: red; }
      a:active { color: red; }
    `;
    const result = await scanCssForHoverOnly(css, 'test.css');
    expect(result).toHaveLength(0);
  });

  it('skips rules inside @media (hover: hover)', async () => {
    const css = `
      @media (hover: hover) {
        button:hover { background: #333; }
      }
    `;
    const result = await scanCssForHoverOnly(css, 'test.css');
    expect(result).toHaveLength(0);
  });

  it('skips rules inside @media (pointer: fine)', async () => {
    const css = `
      @media (pointer: fine) {
        button:hover { opacity: 0.8; }
      }
    `;
    const result = await scanCssForHoverOnly(css, 'test.css');
    expect(result).toHaveLength(0);
  });

  it('skips :hover rules with only cursor:pointer', async () => {
    const css = `
      button:hover { cursor: pointer; }
    `;
    const result = await scanCssForHoverOnly(css, 'test.css');
    expect(result).toHaveLength(0);
  });

  it('skips non-interactive selectors', async () => {
    const css = `
      .card:hover { background-color: lightgray; }
    `;
    const result = await scanCssForHoverOnly(css, 'test.css');
    expect(result).toHaveLength(0);
  });

  it('detects anchor hover without focus', async () => {
    const css = `
      a:hover { color: navy; }
    `;
    const result = await scanCssForHoverOnly(css, 'test.css');
    expect(result.length).toBe(1);
    expect(result[0].kind).toBe('hover_only_affordance');
  });

  it('detects [role=button] hover without focus', async () => {
    const css = `
      [role="button"]:hover { background: green; }
    `;
    const result = await scanCssForHoverOnly(css, 'test.css');
    expect(result.length).toBe(1);
  });

  it('handles large CSS without errors', async () => {
    const lines: string[] = [];
    for (let i = 0; i < 500; i++) {
      lines.push(`.btn-${i}:hover { color: red; }\n.btn-${i}:focus { color: red; }`);
    }
    const css = lines.join('\n');
    const start = Date.now();
    const result = await scanCssForHoverOnly(css, 'large.css');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
    // All have :focus pairs — no detections
    expect(result).toHaveLength(0);
  });

  it('handles @supports blocks correctly', async () => {
    const css = `
      @supports (transform: scale(1)) {
        .btn:hover { transform: scale(1.05); }
      }
    `;
    const result = await scanCssForHoverOnly(css, 'test.css');
    // No focus pair — should detect
    expect(result.length).toBe(1);
  });

  it('does not emit for empty CSS', async () => {
    const result = await scanCssForHoverOnly('', 'empty.css');
    expect(result).toHaveLength(0);
  });
});
