// Positive: floating-point arithmetic on money-named variables.
export function totalCart(items: Array<{ price: number; qty: number }>): number {
  let total = 0.0;
  for (const item of items) {
    total = total + item.price * item.qty;
  }
  return total;
}

export const finalPrice = subtotal * (1 + 0.08);  // tax math on subtotal float
export const refundAmount = parseFloat(req.body.amount);
