// API-key bearer-token middleware for the BugHunter MCP HTTP server.
// V30: any non-empty bearer >= 16 chars is accepted. Server is 127.0.0.1-bound.
// V31 will introduce per-token project-scope ACLs.

import type { Request, Response, NextFunction } from 'express';

export type AuthedRequest = Request & { apiKey: string };

const BEARER_RE = /^Bearer\s+(\S+)$/;

export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const header = req.header('authorization') ?? '';
  const match = BEARER_RE.exec(header);
  if (match === null) {
    res.status(401).json({ error: 'unauthenticated', message: 'Missing Bearer token' });
    return;
  }
  const token = match[1];
  if (token.length < 16) {
    res.status(401).json({ error: 'invalid_token', message: 'Token too short (minimum 16 characters)' });
    return;
  }
  (req as AuthedRequest).apiKey = token;
  next();
}
