// Unit tests for resource-type derivation (v0.21 §10 AC).

import { describe, it, expect } from 'vitest';
import { deriveResourceType, extractResourceTypeFromPath, extractResourceTypeFromField } from './resource-type.js';

describe('extractResourceTypeFromPath', () => {
  it('derives from simple /api/:resource path', () => {
    expect(extractResourceTypeFromPath('/api/orders')).toBe('order');
    expect(extractResourceTypeFromPath('/api/users')).toBe('user');
    expect(extractResourceTypeFromPath('/api/invoices')).toBe('invoice');
  });

  it('derives from /api/vN/:resource path', () => {
    expect(extractResourceTypeFromPath('/api/v1/orders/:id')).toBe('order');
    expect(extractResourceTypeFromPath('/api/v2/products')).toBe('product');
  });

  it('strips trailing s only when stem length >= 3', () => {
    // 'news' → stem 'new' (3 chars) → 'new'
    expect(extractResourceTypeFromPath('/api/news')).toBe('new');
    // 'orders' → stem 'order' (5 chars) → 'order'
    expect(extractResourceTypeFromPath('/api/orders')).toBe('order');
  });

  it('preserves hyphens in resource names', () => {
    expect(extractResourceTypeFromPath('/api/line-items')).toBe('line-item');
  });

  it('returns null for non-api paths', () => {
    expect(extractResourceTypeFromPath('/auth/login')).toBeNull();
    expect(extractResourceTypeFromPath('/webhook/stripe')).toBeNull();
    expect(extractResourceTypeFromPath('')).toBeNull();
  });

  it('handles nested paths — uses first segment after /api/vN/', () => {
    // /api/orders/:id/line-items → first segment after /api/ is 'orders'
    expect(extractResourceTypeFromPath('/api/orders/:id/line-items')).toBe('order');
  });
});

describe('extractResourceTypeFromField', () => {
  it('strips camelCase Id suffix', () => {
    expect(extractResourceTypeFromField('tradeId')).toBe('trade');
    expect(extractResourceTypeFromField('customerId')).toBe('customer');
    expect(extractResourceTypeFromField('orderId')).toBe('order');
  });

  it('strips camelCase Uuid suffix', () => {
    expect(extractResourceTypeFromField('tradeUuid')).toBe('tradeuuid'.replace('uuid', '')); // 'trade'
    expect(extractResourceTypeFromField('invoiceUuid')).toBe('invoice');
  });

  it('strips snake_case _id suffix', () => {
    expect(extractResourceTypeFromField('user_id')).toBe('user');
    expect(extractResourceTypeFromField('order_id')).toBe('order');
  });

  it('strips snake_case _uuid suffix', () => {
    expect(extractResourceTypeFromField('user_uuid')).toBe('user');
  });

  it('returns null for bare field name that does not change', () => {
    expect(extractResourceTypeFromField('id')).toBeNull();
  });

  it('returns null for very short stems', () => {
    // 'aId' → stem 'a' length 1
    expect(extractResourceTypeFromField('aId')).toBeNull();
  });
});

describe('deriveResourceType', () => {
  it('config per-tool override wins', () => {
    expect(deriveResourceType(
      'getOrder', '/api/orders/:id', 'id',
      { resourceTypeOverrides: { getOrder: 'purchase-order' } },
    )).toBe('purchase-order');
  });

  it('config per-path override wins over heuristic', () => {
    expect(deriveResourceType(
      'getOrder', '/api/orders/123', 'id',
      { resourceTypeOverridesByPath: { '/api/orders/:id': 'purchase-order' } },
    )).toBe('purchase-order');
  });

  it('per-tool override wins over per-path override', () => {
    expect(deriveResourceType(
      'getOrder', '/api/orders/123', 'id',
      {
        resourceTypeOverrides: { getOrder: 'tool-override' },
        resourceTypeOverridesByPath: { '/api/orders/:id': 'path-override' },
      },
    )).toBe('tool-override');
  });

  it('URL heuristic when no config override', () => {
    expect(deriveResourceType('getTrade', '/api/trades/:id', 'id', undefined)).toBe('trade');
  });

  it('field-name fallback when path is non-api', () => {
    expect(deriveResourceType('getX', '/v1/x/:id', 'tradeId', undefined)).toBe('trade');
  });

  it('returns _unknown as last resort', () => {
    expect(deriveResourceType('getX', '/v1/x', 'id', undefined)).toBe('_unknown');
  });

  it('with no config (undefined), falls through to heuristic', () => {
    expect(deriveResourceType('listInvoices', '/api/invoices', 'id', undefined)).toBe('invoice');
  });
});
