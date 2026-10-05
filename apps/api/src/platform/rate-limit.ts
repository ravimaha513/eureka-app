/**
 * Fixed-window per-key limiter, in memory per task. Good enough to stop one
 * signed-in user scraping a list; not a global quota (WAF and API Gateway
 * throttling cover volume per IP and overall; the applicant portal also has
 * database-wide caps). The map is hard-capped: at `maxKeys` expired windows
 * are dropped from the oldest end, then the oldest live keys are evicted
 * (a Map keeps insertion order), so a flood of distinct keys costs O(1)
 * amortised per call and bounded memory.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number, private readonly windowMs: number, private readonly now = () => Date.now(),
    private readonly maxKeys = 10_000,
  ) {}

  /** Returns true when the call is allowed. */
  take(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.delete(key);
      while (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next();
        if (oldest.done) break;
        this.windows.delete(oldest.value);
      }
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count += 1;
    return w.count <= this.limit;
  }

  get size(): number { return this.windows.size; }
}
