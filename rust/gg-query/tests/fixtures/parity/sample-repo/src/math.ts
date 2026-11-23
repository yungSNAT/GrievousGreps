export function computeTax(amount: number, rate: number): number {
  return amount * rate;
}

export function computeTotal(subtotal: number, rate: number): number {
  const tax = computeTax(subtotal, rate);
  return subtotal + tax;
}
