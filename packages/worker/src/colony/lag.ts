/**
 * Event-loop lag probe for load tests (enabled with FT_LAG_PROBE). A timer fires every `everyMs`;
 * how late it fires is the time the object's thread was busy (or paused) in between. Each window
 * of `windowMs` logs one line when the worst lag passed `reportMs`, so a stall seen by clients can
 * be told apart: a busy thread shows lag here, a stall outside the thread (storage, network) does not.
 */
export class LagProbe {
  private timer: ReturnType<typeof setInterval> | null = null;
  private expected = 0;
  private worst = 0;
  private windowStart = 0;
  private ticks = 0;

  constructor(
    private readonly label: string,
    private readonly log: (line: string) => void = (line) => console.log(line),
    private readonly everyMs = 100,
    private readonly windowMs = 5_000,
    private readonly reportMs = 250,
  ) {}

  /** Start probing (idempotent). */
  start(now = Date.now()): void {
    if (this.timer !== null) return;
    this.expected = now + this.everyMs;
    this.windowStart = now;
    this.timer = setInterval(() => this.tick(Date.now()), this.everyMs);
  }

  /** Stop probing. */
  stop(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /** One timer firing at `now` (exposed for tests). */
  tick(now: number): void {
    this.worst = Math.max(this.worst, now - this.expected);
    this.ticks++;
    this.expected = now + this.everyMs;
    if (now - this.windowStart < this.windowMs) return;
    if (this.worst >= this.reportMs) this.log(JSON.stringify({ ft: "lag", object: this.label, worstMs: this.worst, ticks: this.ticks, windowMs: now - this.windowStart, at: now }));
    this.worst = 0;
    this.ticks = 0;
    this.windowStart = now;
  }
}
