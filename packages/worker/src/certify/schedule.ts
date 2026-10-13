import type { Sha } from "@fire_trident/core";

/** What the certifier should do now. */
export type ScheduleStep = { kind: "start" } | { kind: "wait"; ms: number } | { kind: "busy" } | { kind: "idle" };

/**
 * When to certify. Landings only mark trunk as moved; a run certifies whatever trunk is when it
 * starts, so when landings come faster than runs, only the newest trunk is certified. At most one
 * run is in flight, and runs start at least `minIntervalMs` apart (landings in a burst share one).
 * Reports of older landings (out of order, or for the commit being certified) change nothing.
 */
export class CertifySchedule {
  private wanted = false;
  private newestAt = 0;
  private running = false;
  private lastStart = Number.NEGATIVE_INFINITY;
  private certified: Sha | null = null;

  /** `minIntervalMs` may change at any time (the colony's policy). */
  constructor(public minIntervalMs: number) {}

  /**
   * A landing moved trunk to `sha` at `at` (landing time). Returns true when it asks for a run:
   * not when an earlier-reported landing was newer, nor when `sha` is certified or being certified.
   */
  request(sha: Sha, at: number): boolean {
    if (at < this.newestAt) return false;
    this.newestAt = at;
    if (sha !== "" && sha === this.certified) return false;
    this.wanted = true;
    return true;
  }

  /** Ask for a run regardless of what was certified (an operator's "certify now"). */
  force(): void {
    this.wanted = true;
    this.certified = null;
  }

  /** The next step at `now`. */
  next(now: number): ScheduleStep {
    if (this.running) return { kind: "busy" };
    if (!this.wanted) return { kind: "idle" };
    const wait = this.lastStart + this.minIntervalMs - now;
    return wait > 0 ? { kind: "wait", ms: Math.ceil(wait) } : { kind: "start" };
  }

  /** A run starts now: it will certify trunk as it is, so the pending request is served. */
  start(now: number): void {
    this.running = true;
    this.wanted = false;
    this.lastStart = now;
  }

  /** The run in flight is certifying `sha` (learned from trunk once it started). */
  certifying(sha: Sha): void {
    this.certified = sha;
  }

  /** The run in flight ended (with the commit it certified, when it got that far). */
  finish(sha: Sha | null): void {
    this.running = false;
    if (sha) this.certified = sha;
  }

  /** A request is waiting. */
  pending(): boolean {
    return this.wanted;
  }

  /** A run is in flight. */
  busy(): boolean {
    return this.running;
  }

  /** Forget everything (the colony was erased). */
  reset(): void {
    this.wanted = false;
    this.newestAt = 0;
    this.running = false;
    this.lastStart = Number.NEGATIVE_INFINITY;
    this.certified = null;
  }
}
