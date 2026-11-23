import { handleOrder } from "./order.js";

export function runCheckout(items: number[]): number {
  const sum = items.reduce((a, b) => a + b, 0);
  return handleOrder(sum);
}
