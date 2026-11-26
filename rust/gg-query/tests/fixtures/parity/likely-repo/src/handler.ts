// Response here is the platform's, which this file never imports.
export function handle(res: Response): number {
  return res.save();
}
