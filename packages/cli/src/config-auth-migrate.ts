// Migration shim for legacy auth.kind: 'credentials' shape (V42-era).
// Converts to the canonical 'cookie' or 'form' kind introduced in V55.
//
// Removal scheduled for v0.60.

import { log } from './log.js';
import type { AuthConfig } from './types.js';

type LegacyCredential = {
  role: string;
  email?: string;
  username?: string;
  password?: string;
};

type LegacyAuthInput = {
  kind: 'credentials';
  loginUrl?: string;
  loginEndpoint?: string;
  tokenStorage?: 'httpOnly-cookie' | 'localStorage' | 'bearer-header';
  credentials?: LegacyCredential[];
};

/**
 * Migrates a legacy `auth.kind: 'credentials'` config block to the modern
 * discriminated union shape. Called by the Zod `.transform()` on the 'credentials'
 * branch of AuthSchema.
 */
export function migrateLegacyCredentials(legacy: LegacyAuthInput): AuthConfig {
  log.warn(
    `config: 'credentials' is a legacy auth.kind; prefer 'cookie' or 'form' (will be removed in v0.60)`
  );

  const credentials: Record<string, { username?: string; email?: string; password?: string }> = {};
  for (const cred of legacy.credentials ?? []) {
    credentials[cred.role] = {
      username: cred.username,
      email: cred.email,
      password: cred.password,
    };
  }

  if (legacy.tokenStorage === 'localStorage') {
    const loginUrl = legacy.loginUrl ?? legacy.loginEndpoint;
    return {
      kind: 'form',
      loginUrl,
      credentials,
    };
  }

  // Default: httpOnly-cookie or bearer-header both map to 'cookie' endpoint
  const rawEndpoint = legacy.loginEndpoint ?? legacy.loginUrl ?? '/api/auth/login';
  const loginEndpointUrl = rawEndpoint.replace(/^POST\s+/i, '');

  return {
    kind: 'cookie',
    loginEndpoint: {
      method: 'POST',
      url: loginEndpointUrl,
      bodyShape: 'json',
      usernameField: 'email',
      passwordField: 'password',
    },
    cookieName: 'session',
    credentials,
  };
}
