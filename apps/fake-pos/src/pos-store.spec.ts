import { describe, expect, it } from 'vitest';
import { loadPosConfig } from './pos-config';
import { PosStore } from './pos-store';

const store = () => new PosStore(loadPosConfig({}));

describe('PosStore', () => {
  it('is not idempotent: the same externalRef twice creates two orders', () => {
    const s = store();
    const input = { externalRef: 'c1', restaurantId: 'r1', items: [], total: 10 };
    s.create(input);
    s.create(input);
    expect(s.findByExternalRef('c1')).toHaveLength(2);
  });

  it('admits 5 requests per restaurant per 10 s, independently per restaurant', () => {
    const s = store();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(s.admit('r1', t0 + i)).toBeNull();
    expect(s.admit('r1', t0 + 10)).toBe(10);
    expect(s.admit('r2', t0 + 10)).toBeNull();
    expect(s.admit('r1', t0 + 10_001)).toBeNull();
  });

  it('cancel is idempotent', () => {
    const s = store();
    const order = s.create({ externalRef: 'c1', restaurantId: 'r1', items: [], total: 10 });
    s.cancel(order);
    const at = order.cancelledAt;
    s.cancel(order);
    expect(order.status).toBe('cancelled');
    expect(order.cancelledAt).toBe(at);
  });
});
