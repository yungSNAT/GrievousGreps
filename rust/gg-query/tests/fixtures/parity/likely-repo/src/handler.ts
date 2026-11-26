import { Store } from "./store";

// Response here is the platform's, which this file never imports.
export function handle(res: Response): number {
  return res.save();
}

// Store is imported from the target's file, so this call is likely, beside the inferred one above.
export function both(s: Store): number {
  return s.save();
}
