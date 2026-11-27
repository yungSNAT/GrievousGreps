import { total } from "../src/lib";

export function checksTotal(): boolean {
  return total(1, 2) === 3;
}
