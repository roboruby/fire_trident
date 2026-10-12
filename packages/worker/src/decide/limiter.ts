/**
 * Admission for model calls: at most `concurrency` in flight, at most `perMinute` started per
 * model in any 60 s window, and a cooldown after the provider throttles a model. Callers wait
 * for a slot up to their own deadline; nothing else in the pipeline waits behind them.
 */
export class CallLimiter {
  private inFlight = 0;
  private readonly waiters = new Set<() => void>();
  private readonly starts = new Map<string, number[]>();
  private readonly coolUntil = new Map<string, number>();

  constructor(
    private concurrency: number,
    private perMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Change the limits (policy updates). */
  configure(concurrency: number, perMinute: number): void {
    this.concurrency = Math.max(1, Math.floor(concurrency));
    this.perMinute = Math.max(1, Math.floor(perMinute));
    this.wake();
  }

  /** Calls in flight now. */
  get active(): number {
    return this.inFlight;
  }

  /** Stop starting calls to `model` for `ms` (the provider throttled it). */
  cooldown(model: string, ms: number): void {
    this.coolUntil.set(model, Math.max(this.coolUntil.get(model) ?? 0, this.now() + ms));
  }

  /** How long until `model` may start another call (0 when it may start now). */
  waitFor(model: string): number {
    const t = this.now();
    const cool = Math.max(0, (this.coolUntil.get(model) ?? 0) - t);
    const recent = (this.starts.get(model) ?? []).filter((s) => t - s < 60_000);
    this.starts.set(model, recent);
    const rate = recent.length < this.perMinute ? 0 : 60_000 - (t - recent[0]!);
    const slot = this.inFlight < this.concurrency ? 0 : 1;
    return Math.max(cool, rate, slot);
  }

  /**
   * Wait for a slot for `model`. Resolves with a release function, or null when the deadline
   * passes first.
   */
  async acquire(model: string, deadline: number): Promise<(() => void) | null> {
    for (;;) {
      const wait = this.waitFor(model);
      if (wait === 0) {
        this.inFlight++;
        this.starts.get(model)!.push(this.now());
        let released = false;
        return () => {
          if (released) return;
          released = true;
          this.inFlight--;
          this.wake();
        };
      }
      const left = deadline - this.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          this.waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(left, Math.max(50, wait === 1 ? 1_000 : wait)));
        this.waiters.add(done);
      });
    }
  }

  private wake(): void {
    for (const w of [...this.waiters]) w();
  }
}
