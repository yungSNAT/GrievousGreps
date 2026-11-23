import { computeTotal } from "./math.js";

export class OrderService {
  processOrder(subtotal: number): number {
    return computeTotal(subtotal, 0.1);
  }
}

export function handleOrder(subtotal: number): number {
  const service = new OrderService();
  return service.processOrder(subtotal);
}
