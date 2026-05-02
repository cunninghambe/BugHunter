import { describe, it, expect, vi, afterEach } from 'vitest';
import { portFromUrl } from './process.js';

// Note: process spawn/kill tests are platform-specific and rely on OS process management.
// We test the pure helper functions here; integration tests cover spawn/kill behavior.

describe('portFromUrl', () => {
  it('extracts explicit port', () => {
    expect(portFromUrl('http://localhost:3000/')).toBe(3000);
    expect(portFromUrl('http://localhost:8080/app')).toBe(8080);
  });

  it('defaults to 80 for http', () => {
    expect(portFromUrl('http://example.com/')).toBe(80);
  });

  it('defaults to 443 for https', () => {
    expect(portFromUrl('https://example.com/')).toBe(443);
  });

  it('defaults to 3000 on invalid URL', () => {
    expect(portFromUrl('not-a-url')).toBe(3000);
  });
});
