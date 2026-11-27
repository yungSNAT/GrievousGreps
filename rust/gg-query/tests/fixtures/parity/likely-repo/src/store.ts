export class Store {
  save(): number {
    return 1;
  }
}

export interface Response extends Store {}

export function direct(s: Store): number {
  return s.save();
}
