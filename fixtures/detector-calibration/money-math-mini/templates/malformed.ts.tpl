// Input degradation: malformed TypeScript with money float math — scanner should still flag it.
export function chargeCustomer(req {
  const total = req.body.priceUsd * 1.08;  // float math on USD-named variable
  return total
// missing close brace
