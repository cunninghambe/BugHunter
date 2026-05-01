import { describe, it, expect, vi } from 'vitest';
import { requireApiKey } from './auth.js';
import type { Request, Response, NextFunction } from 'express';

function makeReq(authHeader?: string): Request {
  return { header: (name: string) => name.toLowerCase() === 'authorization' ? authHeader : undefined } as unknown as Request;
}

type ResCtx = { status: number | undefined; body: unknown; res: Response };

function makeRes(): ResCtx {
  const ctx: ResCtx = { status: undefined, body: undefined, res: null as unknown as Response };
  ctx.res = {
    status: (code: number) => { ctx.status = code; return ctx.res; },
    json: (body: unknown) => { ctx.body = body; return ctx.res; },
  } as unknown as Response;
  return ctx;
}

describe('requireApiKey', () => {
  it('returns 401 when Authorization header is missing', () => {
    const req = makeReq(undefined);
    const ctx = makeRes();
    const next = vi.fn();
    requireApiKey(req, ctx.res, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.status).toBe(401);
  });

  it('returns 401 for malformed header (no Bearer prefix)', () => {
    const req = makeReq('Basic abc123');
    const ctx = makeRes();
    const next = vi.fn();
    requireApiKey(req, ctx.res, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.status).toBe(401);
  });

  it('returns 401 for a token shorter than 16 characters', () => {
    const req = makeReq('Bearer short');
    const ctx = makeRes();
    const next = vi.fn();
    requireApiKey(req, ctx.res, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.status).toBe(401);
  });

  it('calls next() and attaches apiKey for a valid token (>= 16 chars)', () => {
    const token = 'valid-token-here-1234';
    const req = makeReq(`Bearer ${token}`) as Request & { apiKey?: string };
    const ctx = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    requireApiKey(req, ctx.res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.apiKey).toBe(token);
  });

  it('accepts a 16-character token (minimum length)', () => {
    const token = 'a'.repeat(16);
    const req = makeReq(`Bearer ${token}`) as Request & { apiKey?: string };
    const ctx = makeRes();
    const next = vi.fn() as unknown as NextFunction;
    requireApiKey(req, ctx.res, next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 401 for a 15-character token (below minimum)', () => {
    const token = 'a'.repeat(15);
    const req = makeReq(`Bearer ${token}`);
    const ctx = makeRes();
    const next = vi.fn();
    requireApiKey(req, ctx.res, next);
    expect(next).not.toHaveBeenCalled();
    expect(ctx.status).toBe(401);
  });
});
