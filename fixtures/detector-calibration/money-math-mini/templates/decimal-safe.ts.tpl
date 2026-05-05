// Negative: uses integer cents (Stripe convention) — no float math on money.
import Decimal from 'decimal.js';

export function totalCart(items: Array<{ priceCents: number; qty: number }>): number {
  let totalCents = 0;
  for (const item of items) {
    totalCents = totalCents + item.priceCents * item.qty;
  }
  return totalCents;
}

export function applyDiscount(subtotalCents: number, discountBps: number): number {
  return Math.floor((subtotalCents * (10000 - discountBps)) / 10000);
}

export const refundAmount = new Decimal(req.body.amount).toNumber();
