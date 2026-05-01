import { describe, it, expect } from 'vitest';
import { computeBugIdentity } from './bug-identity.js';

describe('computeBugIdentity', () => {
  it('returns a 16-char lowercase hex string', () => {
    const id = computeBugIdentity('my-project', 'console_error::Uncaught TypeError::stack');
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable — same inputs always produce same identity', () => {
    const a = computeBugIdentity('acme-shop', 'network_5xx::POST::/api/checkout::500');
    const b = computeBugIdentity('acme-shop', 'network_5xx::POST::/api/checkout::500');
    expect(a).toBe(b);
  });

  it('regression guard — identity does not drift across calls', () => {
    const id = computeBugIdentity('bughunter-demo', 'console_error::TypeError: foo::fp-abc123');
    expect(id).toBe(computeBugIdentity('bughunter-demo', 'console_error::TypeError: foo::fp-abc123'));
    expect(id).toHaveLength(16);
    expect(id).toMatch(/^[0-9a-f]{16}$/);
  });

  it('prevents prefix-collision — "fooBAR" + "sig" differs from "foo" + "BARsig"', () => {
    const a = computeBugIdentity('fooBAR', 'sig');
    const b = computeBugIdentity('foo', 'BARsig');
    expect(a).not.toBe(b);
  });

  it('different projectNames produce different identities for the same signatureKey', () => {
    const sig = 'network_5xx::GET::/api/users::500';
    const a = computeBugIdentity('project-alpha', sig);
    const b = computeBugIdentity('project-beta', sig);
    expect(a).not.toBe(b);
  });

  it('different signatureKeys produce different identities for the same projectName', () => {
    const project = 'my-app';
    const a = computeBugIdentity(project, 'console_error::TypeError: Cannot read');
    const b = computeBugIdentity(project, 'network_5xx::POST::/api/login::500');
    expect(a).not.toBe(b);
  });
});
