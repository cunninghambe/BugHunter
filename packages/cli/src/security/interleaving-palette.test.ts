// Unit tests for the v0.19 interleaving palette module.

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_VARIANTS,
  makeDoubleSubmit,
  makeClickThenNavigate,
  makeOptimisticRevert,
  makeInterleavedMutations,
  makeCrossTab,
  isSensitiveToolPath,
  isIdempotentTool,
  normalizeToolPath,
  extractMutatingActionTuples,
  pairSiblings,
} from './interleaving-palette.js';
import type { RaceConditionsConfig, TestCase, ToolMeta } from '../types.js';

const baseConfig: RaceConditionsConfig = { enabled: true };

describe('DEFAULT_VARIANTS', () => {
  it('does not include cross_tab by default', () => {
    expect(DEFAULT_VARIANTS).not.toContain('cross_tab');
  });

  it('includes the four enabled-by-default kinds', () => {
    expect(DEFAULT_VARIANTS).toContain('double_submit');
    expect(DEFAULT_VARIANTS).toContain('click_then_navigate');
    expect(DEFAULT_VARIANTS).toContain('optimistic_revert');
    expect(DEFAULT_VARIANTS).toContain('interleaved_mutations');
  });
});

describe('makeDoubleSubmit', () => {
  it('uses config doubleSubmitGapMs when provided', () => {
    const v = makeDoubleSubmit({ ...baseConfig, doubleSubmitGapMs: 100 });
    expect(v.kind).toBe('double_submit');
    expect(v.gapMs).toBe(100);
  });

  it('defaults gapMs to 50', () => {
    const v = makeDoubleSubmit(baseConfig);
    expect(v.gapMs).toBe(50);
  });
});

describe('makeClickThenNavigate', () => {
  it('sets targetRoute', () => {
    const v = makeClickThenNavigate('/dashboard');
    expect(v.kind).toBe('click_then_navigate');
    expect(v.targetRoute).toBe('/dashboard');
  });

  it('sets preFireDelayMs to 0', () => {
    const v = makeClickThenNavigate('/dashboard');
    expect(v.preFireDelayMs).toBe(0);
  });
});

describe('makeOptimisticRevert', () => {
  it('uses config forcedStatus when provided', () => {
    const v = makeOptimisticRevert({ ...baseConfig, optimisticRevertForcedStatus: 503 });
    expect(v.kind).toBe('optimistic_revert');
    expect(v.forcedStatus).toBe(503);
  });

  it('defaults forcedStatus to 500', () => {
    const v = makeOptimisticRevert(baseConfig);
    expect(v.forcedStatus).toBe(500);
  });
});

describe('makeInterleavedMutations', () => {
  it('sets siblingActionId and consensusRuns', () => {
    const v = makeInterleavedMutations('sibling-tool', { ...baseConfig, consensusRuns: 5 });
    expect(v.kind).toBe('interleaved_mutations');
    expect(v.siblingActionId).toBe('sibling-tool');
    expect(v.consensusRuns).toBe(5);
  });

  it('defaults consensusRuns to 3', () => {
    const v = makeInterleavedMutations('sibling-tool', baseConfig);
    expect(v.consensusRuns).toBe(3);
  });
});

describe('makeCrossTab', () => {
  it('sets settleMs to 5000', () => {
    const v = makeCrossTab(baseConfig);
    expect(v.kind).toBe('cross_tab');
    expect(v.settleMs).toBe(5000);
  });
});

describe('isSensitiveToolPath', () => {
  it('returns true for /login path', () => {
    expect(isSensitiveToolPath('/api/login')).toBe(true);
  });

  it('returns true for /signup path', () => {
    expect(isSensitiveToolPath('/api/signup')).toBe(true);
  });

  it('returns true for /payment path', () => {
    expect(isSensitiveToolPath('/api/payment/process')).toBe(true);
  });

  it('returns false for a normal mutation path', () => {
    expect(isSensitiveToolPath('/api/posts')).toBe(false);
  });

  it('returns false when path is in aggressiveRaceTargets', () => {
    expect(isSensitiveToolPath('/api/login', ['/api/login'])).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isSensitiveToolPath('/API/LOGIN')).toBe(true);
  });
});

describe('isIdempotentTool', () => {
  it('returns true for a listed toolId', () => {
    expect(isIdempotentTool('create-order', ['create-order', 'send-email'])).toBe(true);
  });

  it('returns false for an unlisted toolId', () => {
    expect(isIdempotentTool('create-order', ['send-email'])).toBe(false);
  });

  it('returns false when list is empty', () => {
    expect(isIdempotentTool('create-order', [])).toBe(false);
  });

  it('returns false when list is omitted', () => {
    expect(isIdempotentTool('create-order')).toBe(false);
  });
});

describe('normalizeToolPath', () => {
  it('replaces numeric IDs with :id', () => {
    expect(normalizeToolPath('/api/posts/123')).toBe('/api/posts/:id');
  });

  it('replaces UUIDs with :id', () => {
    expect(normalizeToolPath('/api/users/a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe('/api/users/:id');
  });

  it('leaves non-ID segments intact', () => {
    expect(normalizeToolPath('/api/posts')).toBe('/api/posts');
  });

  it('replaces multiple IDs in one path', () => {
    expect(normalizeToolPath('/api/users/42/posts/99')).toBe('/api/users/:id/posts/:id');
  });
});

// Helper to build a minimal TestCase
function makeTestCase(opts: {
  role: string;
  toolId: string;
  palette?: string;
  via?: string;
}): TestCase {
  return {
    id: `tc-${opts.toolId}-${opts.role}`,
    role: opts.role,
    action: {
      via: (opts.via ?? 'ui') as 'ui' | 'api',
      palette: (opts.palette ?? 'happy') as 'happy' | 'minimal' | 'full',
      toolId: opts.toolId,
      selector: '#submit',
      value: 'test',
    },
    formSignature: `${opts.role}|${opts.toolId}`,
  } as unknown as TestCase;
}

function makeToolMeta(toolId: string, path: string, sideEffectClass: 'mutating' | 'read'): ToolMeta {
  return { toolId, path, sideEffectClass } as unknown as ToolMeta;
}

describe('extractMutatingActionTuples', () => {
  it('filters to happy-palette UI actions with mutating sideEffectClass', () => {
    const tc1 = makeTestCase({ role: 'user', toolId: 'create-post' });
    const tc2 = makeTestCase({ role: 'user', toolId: 'get-posts', palette: 'happy' });
    const toolMap = new Map<string, ToolMeta>([
      ['create-post', makeToolMeta('create-post', '/api/posts', 'mutating')],
      ['get-posts', makeToolMeta('get-posts', '/api/posts', 'read')],
    ]);

    const result = extractMutatingActionTuples([tc1, tc2], toolMap);
    expect(result).toHaveLength(1);
    expect(result[0]?.toolId).toBe('create-post');
  });

  it('skips API-via test cases', () => {
    const tc = makeTestCase({ role: 'user', toolId: 'create-post', via: 'api' });
    const toolMap = new Map<string, ToolMeta>([
      ['create-post', makeToolMeta('create-post', '/api/posts', 'mutating')],
    ]);
    expect(extractMutatingActionTuples([tc], toolMap)).toHaveLength(0);
  });

  it('deduplicates (role, toolId) pairs', () => {
    const tc1 = makeTestCase({ role: 'user', toolId: 'create-post' });
    const tc2 = makeTestCase({ role: 'user', toolId: 'create-post' });
    const toolMap = new Map<string, ToolMeta>([
      ['create-post', makeToolMeta('create-post', '/api/posts', 'mutating')],
    ]);
    expect(extractMutatingActionTuples([tc1, tc2], toolMap)).toHaveLength(1);
  });

  it('keeps distinct roles separate', () => {
    const tc1 = makeTestCase({ role: 'admin', toolId: 'create-post' });
    const tc2 = makeTestCase({ role: 'user', toolId: 'create-post' });
    const toolMap = new Map<string, ToolMeta>([
      ['create-post', makeToolMeta('create-post', '/api/posts', 'mutating')],
    ]);
    expect(extractMutatingActionTuples([tc1, tc2], toolMap)).toHaveLength(2);
  });
});

describe('pairSiblings', () => {
  const postMeta = (toolId: string) => makeToolMeta(toolId, `/api/posts/:id`, 'mutating');
  const tc = (role: string, toolId: string) => makeTestCase({ role, toolId });

  it('auto-pairs two tools on the same normalized path for the same role', () => {
    const tuples = [
      { role: 'user', toolId: 'update-post', toolPath: '/api/posts/123', testCase: tc('user', 'update-post') },
      { role: 'user', toolId: 'patch-post', toolPath: '/api/posts/456', testCase: tc('user', 'patch-post') },
    ];
    void postMeta; // used in other tests
    const pairs = pairSiblings(tuples, baseConfig);
    expect(pairs.get('update-post')).toBe('patch-post');
    expect(pairs.get('patch-post')).toBe('update-post');
  });

  it('does not pair tools on different normalized paths', () => {
    const tuples = [
      { role: 'user', toolId: 'create-post', toolPath: '/api/posts', testCase: tc('user', 'create-post') },
      { role: 'user', toolId: 'delete-comment', toolPath: '/api/comments/1', testCase: tc('user', 'delete-comment') },
    ];
    const pairs = pairSiblings(tuples, baseConfig);
    expect(pairs.size).toBe(0);
  });

  it('uses explicit pairedToolIds from config over auto-pairing', () => {
    const tuples = [
      { role: 'user', toolId: 'update-post', toolPath: '/api/posts/1', testCase: tc('user', 'update-post') },
      { role: 'user', toolId: 'patch-post', toolPath: '/api/posts/2', testCase: tc('user', 'patch-post') },
    ];
    const config: RaceConditionsConfig = {
      ...baseConfig,
      pairedToolIds: [['update-post', 'explicit-sibling']],
    };
    const pairs = pairSiblings(tuples, config);
    expect(pairs.get('update-post')).toBe('explicit-sibling');
    // auto-pairing result not present since explicit pairs short-circuit
    expect(pairs.has('patch-post')).toBe(false);
  });
});
