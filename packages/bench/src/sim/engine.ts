/**
 * Discrete-event simulation primitives: a seeded random source and an event queue.
 * Deterministic: the same seed and inputs give the same run.
 */

/** Seeded PRNG (mulberry32) with the samplers the simulator needs. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }

  /** Standard normal (Box-Muller). */
  normal(): number {
    const u = 1 - this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Log-normal with the given median and log-space sigma. */
  lognormal(median: number, sigma: number): number {
    return median * Math.exp(sigma * this.normal());
  }

  /** The retry jitter the ColonyDO applies: ms * U(0.75, 1.25), rounded. */
  jitter(ms: number): number {
    return Math.round(ms * (0.75 + this.next() * 0.5));
  }

  /** A function view for APIs that take `rand: () => number`. */
  fn(): () => number {
    return () => this.next();
  }
}

/** Walker alias table: O(1) sampling from a discrete distribution. */
export class Alias {
  private readonly prob: Float64Array;
  private readonly alias: Int32Array;
  readonly size: number;

  constructor(weights: number[]) {
    const n = weights.length;
    this.size = n;
    this.prob = new Float64Array(n);
    this.alias = new Int32Array(n);
    const total = weights.reduce((a, b) => a + Math.max(0, b), 0);
    if (n === 0 || total <= 0) throw new Error("alias table needs a positive weight");
    const scaled = weights.map((w) => (Math.max(0, w) * n) / total);
    const small: number[] = [];
    const large: number[] = [];
    scaled.forEach((p, i) => (p < 1 ? small : large).push(i));
    while (small.length > 0 && large.length > 0) {
      const s = small.pop()!;
      const l = large.pop()!;
      this.prob[s] = scaled[s]!;
      this.alias[s] = l;
      scaled[l] = scaled[l]! + scaled[s]! - 1;
      (scaled[l]! < 1 ? small : large).push(l);
    }
    for (const i of [...small, ...large]) this.prob[i] = 1;
  }

  /** One index, distributed by the weights. */
  sample(rng: Rng): number {
    const i = rng.int(this.size);
    return rng.next() < this.prob[i]! ? i : this.alias[i]!;
  }
}

/** Min-heap of timed callbacks; ties run in scheduling order. */
export class EventQueue {
  private times: number[] = [];
  private seqs: number[] = [];
  private fns: Array<() => void> = [];
  private seq = 0;
  now = 0;
  processed = 0;

  get size(): number {
    return this.times.length;
  }

  /** Run `fn` at absolute time `t` (never before now). */
  at(t: number, fn: () => void): void {
    const time = t < this.now ? this.now : t;
    const s = this.seq++;
    let i = this.times.length;
    this.times.push(time);
    this.seqs.push(s);
    this.fns.push(fn);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.times[p]! < time || (this.times[p] === time && this.seqs[p]! < s)) break;
      this.times[i] = this.times[p]!;
      this.seqs[i] = this.seqs[p]!;
      this.fns[i] = this.fns[p]!;
      i = p;
    }
    this.times[i] = time;
    this.seqs[i] = s;
    this.fns[i] = fn;
  }

  /** Run `fn` after `dt` ms. */
  after(dt: number, fn: () => void): void {
    this.at(this.now + Math.max(0, dt), fn);
  }

  /** Process events until the queue is empty or the next one is after `until`. */
  run(until: number): void {
    while (this.times.length > 0 && this.times[0]! <= until) {
      const fn = this.pop();
      fn();
      this.processed++;
    }
    if (this.now < until) this.now = until;
  }

  private pop(): () => void {
    const t0 = this.times[0]!;
    const f0 = this.fns[0]!;
    const lastT = this.times.pop()!;
    const lastS = this.seqs.pop()!;
    const lastF = this.fns.pop()!;
    const n = this.times.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= n) break;
        const r = l + 1;
        let c = l;
        if (r < n && (this.times[r]! < this.times[l]! || (this.times[r] === this.times[l] && this.seqs[r]! < this.seqs[l]!))) c = r;
        if (this.times[c]! > lastT || (this.times[c] === lastT && this.seqs[c]! > lastS)) break;
        this.times[i] = this.times[c]!;
        this.seqs[i] = this.seqs[c]!;
        this.fns[i] = this.fns[c]!;
        i = c;
      }
      this.times[i] = lastT;
      this.seqs[i] = lastS;
      this.fns[i] = lastF;
    }
    this.now = t0;
    return f0;
  }
}

/** Nearest-rank quantile of an ascending array (null when empty). */
export function q(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil(Math.min(1, Math.max(0, p)) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))] ?? null;
}
