import { Store } from "./store";

export function run(s: Store): number {
  return s.save();
}
