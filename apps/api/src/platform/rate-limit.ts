/**
 * Fixed-window per-key limiter, in memory per task. Good enough to stop one
 * signed-in user scraping a list; not a global quota (WAF and API Gateway
 * throttling cover volume per IP and overall).
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now = () => Date.now()) {}

  /** Returns true when the call is allowed. */
  take(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      if (this.windows.size > 10_000) this.sweep(t);
      return true;
    }
    w.count += 1;
    return w.count <= this.limit;
  }

  private sweep(t: number) {
    for (const [k, w] of this.windows) if (t - w.start >= this.windowMs) this.windows.delete(k);
  }
}
