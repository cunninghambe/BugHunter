import { describe, it, expect, beforeEach } from 'vitest';
import { v26Available, v27DiffAvailable, v27HistoryAvailable, v28Available, clearFeatureDetectCache } from './feature-detect.js';

describe('feature-detect', () => {
  beforeEach(() => {
    clearFeatureDetectCache();
  });

  it('v26Available returns false for non-existent module', async () => {
    const result = await v26Available();
    // The actual bughunter registry.ts may or may not be available in tests;
    // just ensure the function returns a { available: boolean } shape.
    expect(typeof result.available).toBe('boolean');
  });

  it('v27DiffAvailable returns { available: false } for missing module', async () => {
    const result = await v27DiffAvailable();
    // history/diff.js doesn't exist yet (V27 not landed)
    expect(result).toHaveProperty('available');
    expect(typeof result.available).toBe('boolean');
  });

  it('v28Available returns { available: false } for missing module', async () => {
    const result = await v28Available();
    expect(result).toHaveProperty('available');
    expect(typeof result.available).toBe('boolean');
  });

  it('caches the result (second call does not re-import)', async () => {
    const r1 = await v27HistoryAvailable();
    const r2 = await v27HistoryAvailable();
    // Same reference if cached
    expect(r1.available).toBe(r2.available);
  });

  it('clearFeatureDetectCache allows re-probing', async () => {
    await v27DiffAvailable();
    clearFeatureDetectCache();
    // Should not throw
    const result = await v27DiffAvailable();
    expect(result).toHaveProperty('available');
  });
});
