// Per-entity token bucket at the MCP edge. Keyed by authenticated entity id (not IP or session),
// so opening more sessions with the same key does not buy more throughput.

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly perMinute: number, private readonly now: () => number = () => Date.now()) {}

  take(key: string): boolean {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: t };
    b.tokens = Math.min(this.perMinute, b.tokens + ((t - b.at) / 60_000) * this.perMinute);
    b.at = t;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}
