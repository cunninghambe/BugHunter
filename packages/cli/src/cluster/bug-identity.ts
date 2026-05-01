// Stable bug identity — 16-char hex derived from (projectName, signatureKey).
// Space separator prevents prefix-collision between projectName variants.

import { createHash } from 'node:crypto';

export function computeBugIdentity(projectName: string, signatureKey: string): string {
  return createHash('sha256')
    .update(projectName)
    .update(' ')
    .update(signatureKey)
    .digest('hex')
    .slice(0, 16);
}
