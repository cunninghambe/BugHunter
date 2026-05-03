// Unit tests for cross-surface form → api tool resolution. SurfaceMCP#23.

import { describe, it, expect, vi } from 'vitest';
import { crossRefForms, normalizeActionPath } from './form-cross-ref.js';
import type { DiscoveredForm, ToolMeta } from '../types.js';
import type { SurfaceMcpAdapter } from '../adapters/surface-mcp.js';

function makeTool(method: string, path: string, toolId: string): ToolMeta {
  return {
    toolId,
    name: `${method.toLowerCase()}_${path.replace(/\//g, '_').replace(/^_/, '')}`,
    method,
    path,
    inputSchema: { type: 'object', properties: {} },
    inputSchemaConfidence: 'inferred',
    sideEffectClass: 'mutating',
    sourceFile: 'routes/auth.ts',
    sourceLine: 1,
    isServerAction: false,
  };
}

function makeForm(action: string | undefined, method: string): DiscoveredForm {
  return {
    formSelector: 'form',
    fields: [{ name: 'username', type: 'text', required: true }],
    action,
    method,
  };
}

function makeSurface(toolIds: string[]): SurfaceMcpAdapter {
  return {
    surface_routes_for_page: vi.fn().mockResolvedValue({ tools: toolIds.map(id => ({ toolId: id, name: id, sourceLocation: '' })) }),
  } as unknown as SurfaceMcpAdapter;
}

describe('normalizeActionPath', () => {
  it('returns pathname from an absolute URL', () => {
    expect(normalizeActionPath('http://localhost:3001/api/login')).toBe('/api/login');
  });

  it('returns relative path unchanged when already prefixed with /', () => {
    expect(normalizeActionPath('/api/login')).toBe('/api/login');
  });

  it('prefixes a bare relative path with /', () => {
    expect(normalizeActionPath('api/login')).toBe('/api/login');
  });

  it('returns empty string for undefined', () => {
    expect(normalizeActionPath(undefined)).toBe('');
  });

  it('returns empty string for empty string', () => {
    expect(normalizeActionPath('')).toBe('');
  });
});

describe('crossRefForms — surface_routes_for_page returns tools', () => {
  it('assigns tool IDs from surface_routes_for_page to all forms on the page', async () => {
    const surface = makeSurface(['tool-abc']);
    const forms = [makeForm('/api/login', 'POST'), makeForm(undefined, 'GET')];
    const result = await crossRefForms(forms, 'src/pages/login.tsx', surface);
    expect(result[0]?.apiToolIds).toEqual(['tool-abc']);
    expect(result[1]?.apiToolIds).toEqual(['tool-abc']);
  });
});

describe('crossRefForms — cross-surface action match (SurfaceMCP#23)', () => {
  it('resolves form action /api/login to api-surface POST /api/login tool', async () => {
    const surface = makeSurface([]); // vite surface returns 0 tools
    const apiTools = [makeTool('POST', '/api/login', 'post_api_login')];
    const forms = [makeForm('/api/login', 'POST')];

    const result = await crossRefForms(forms, '/login', surface, apiTools);

    expect(result[0]?.apiToolIds).toEqual(['post_api_login']);
  });

  it('does not match a tool with the wrong method', async () => {
    const surface = makeSurface([]);
    const apiTools = [makeTool('GET', '/api/login', 'get_api_login')];
    const forms = [makeForm('/api/login', 'POST')];

    const result = await crossRefForms(forms, '/login', surface, apiTools);

    expect(result[0]?.apiToolIds).toEqual([]);
  });

  it('does not match a tool with a different path', async () => {
    const surface = makeSurface([]);
    const apiTools = [makeTool('POST', '/api/auth', 'post_api_auth')];
    const forms = [makeForm('/api/login', 'POST')];

    const result = await crossRefForms(forms, '/login', surface, apiTools);

    expect(result[0]?.apiToolIds).toEqual([]);
  });

  it('matches absolute action URL to api tool by pathname', async () => {
    const surface = makeSurface([]);
    const apiTools = [makeTool('POST', '/api/login', 'post_api_login')];
    const forms = [makeForm('http://localhost:3001/api/login', 'POST')];

    const result = await crossRefForms(forms, '/login', surface, apiTools);

    expect(result[0]?.apiToolIds).toEqual(['post_api_login']);
  });

  it('returns empty apiToolIds for forms with no action', async () => {
    const surface = makeSurface([]);
    const apiTools = [makeTool('POST', '/api/login', 'post_api_login')];
    const forms = [makeForm(undefined, 'POST')];

    const result = await crossRefForms(forms, '/login', surface, apiTools);

    expect(result[0]?.apiToolIds).toEqual([]);
  });

  it('falls back to empty when apiTools is undefined and surface returns 0', async () => {
    const surface = makeSurface([]);
    const forms = [makeForm('/api/login', 'POST')];

    const result = await crossRefForms(forms, '/login', surface);

    expect(result[0]?.apiToolIds).toEqual([]);
  });

  it('matches multiple tools for the same action when overloaded', async () => {
    const surface = makeSurface([]);
    const apiTools = [
      makeTool('POST', '/api/login', 'post_api_login_v1'),
      makeTool('POST', '/api/login', 'post_api_login_v2'),
    ];
    const forms = [makeForm('/api/login', 'POST')];

    const result = await crossRefForms(forms, '/login', surface, apiTools);

    expect(result[0]?.apiToolIds).toEqual(['post_api_login_v1', 'post_api_login_v2']);
  });

  it('method comparison is case-insensitive', async () => {
    const surface = makeSurface([]);
    const apiTools = [makeTool('post', '/api/login', 'post_api_login')];
    const forms = [makeForm('/api/login', 'POST')];

    const result = await crossRefForms(forms, '/login', surface, apiTools);

    expect(result[0]?.apiToolIds).toEqual(['post_api_login']);
  });
});
