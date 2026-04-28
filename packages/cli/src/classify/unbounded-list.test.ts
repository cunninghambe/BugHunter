// Tests for unbounded-list classifier (§4.4).

import { describe, it, expect } from 'vitest';
import { classifyUnboundedList, jaccard } from './unbounded-list.js';

function tbody(rowCount: number, parentWrapper = ''): string {
  const rows = Array.from({ length: rowCount }, () => '<tr class="row"><td>data</td></tr>').join('');
  const table = `<table><tbody>${rows}</tbody></table>`;
  if (parentWrapper !== '') return `<div ${parentWrapper}>${table}</div>`;
  return table;
}

function ulList(itemCount: number, parentAttrs = ''): string {
  const items = Array.from({ length: itemCount }, () => '<li class="item">item</li>').join('');
  return `<ul ${parentAttrs}>${items}</ul>`;
}

describe('jaccard similarity', () => {
  it('identical sets = 1.0', () => {
    expect(jaccard(['a', 'b'], ['a', 'b'])).toBe(1);
  });

  it('disjoint sets = 0', () => {
    expect(jaccard(['a'], ['b'])).toBe(0);
  });

  it('partial overlap', () => {
    const j = jaccard(['a', 'b', 'c'], ['b', 'c', 'd']);
    expect(j).toBeCloseTo(0.5, 1);
  });

  it('both empty = 1.0', () => {
    expect(jaccard([], [])).toBe(1);
  });
});

describe('classifyUnboundedList', () => {
  it('T1: tbody with 250 tr rows, no virtualization → emit', () => {
    const dom = tbody(250);
    const result = classifyUnboundedList(dom, '/list');
    expect(result.filter(d => d.kind === 'unbounded_list_render')).toHaveLength(1);
    const d = result[0];
    expect((d.evidence as { rowCount: number }).rowCount).toBe(250);
  });

  it('T2: tbody with 250 rows wrapped in data-virtualized parent → no emit', () => {
    const dom = tbody(250, 'data-virtualized="true"');
    const result = classifyUnboundedList(dom, '/list');
    expect(result.filter(d => d.kind === 'unbounded_list_render')).toHaveLength(0);
  });

  it('T3: ul with 50 li items → no emit (under threshold)', () => {
    const dom = ulList(50);
    const result = classifyUnboundedList(dom, '/list');
    expect(result.filter(d => d.kind === 'unbounded_list_render')).toHaveLength(0);
  });

  it('T5: react-window class on parent → no emit', () => {
    const items = Array.from({ length: 500 }, () => '<li>row</li>').join('');
    const dom = `<ul class="react-window">${items}</ul>`;
    const result = classifyUnboundedList(dom, '/list');
    expect(result.filter(d => d.kind === 'unbounded_list_render')).toHaveLength(0);
  });

  it('respects custom threshold', () => {
    const dom = tbody(150);
    const resultDefault = classifyUnboundedList(dom, '/list', 100);
    expect(resultDefault.filter(d => d.kind === 'unbounded_list_render')).toHaveLength(1);
    const resultHigher = classifyUnboundedList(dom, '/list', 200);
    expect(resultHigher.filter(d => d.kind === 'unbounded_list_render')).toHaveLength(0);
  });

  it('evidence contains virtualizationSignals empty array when no signals', () => {
    const dom = tbody(250);
    const result = classifyUnboundedList(dom, '/list');
    expect(result).toHaveLength(1);
    expect((result[0].evidence as { virtualizationSignals: string[] }).virtualizationSignals).toEqual([]);
  });

  it('tanstack-virtual class on container → no emit', () => {
    const rows = Array.from({ length: 200 }, () => '<li>row</li>').join('');
    const dom = `<ul class="tanstack-virtual">${rows}</ul>`;
    const result = classifyUnboundedList(dom, '/list');
    expect(result.filter(d => d.kind === 'unbounded_list_render')).toHaveLength(0);
  });

  it('ol with 250 li rows → emit', () => {
    const items = Array.from({ length: 250 }, () => '<li class="row">item</li>').join('');
    const dom = `<ol>${items}</ol>`;
    const result = classifyUnboundedList(dom, '/list');
    expect(result.filter(d => d.kind === 'unbounded_list_render')).toHaveLength(1);
  });

  it('returns empty for empty snapshot', () => {
    const result = classifyUnboundedList('', '/page');
    expect(result).toHaveLength(0);
  });
});
