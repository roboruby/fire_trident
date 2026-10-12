import type { FieldReading, Id, Intent, Path } from "./types.ts";

const REINFORCE_FACTOR = 0.8;
const THETA_FLOOR = 0.1;

/**
 * Lateral inhibition threshold, as a claim value (a fresh claim is worth 1): an open intent whose
 * own footprint paths carry at least this much live claim from other agents is not taken. Half a
 * fresh claim: heartbeats keep a working agent's claim above it, while a silent agent's claim
 * (tau = 5 min) falls below it after one half-life, about 3.5 minutes. Suppression, not a lock.
 */
export const LATERAL_INHIBITION = 0.5;

/**
 * Bonabeau/Theraulaz/Deneubourg response function: s^2 / (s^2 + theta^2).
 * 0 when s <= 0 (or NaN, or theta is NaN), 1 when theta <= 0.
 */
export function responseProbability(stimulus: number, theta: number): number {
  if (!(stimulus > 0) || Number.isNaN(theta)) return 0;
  if (theta <= 0) return 1;
  const s2 = stimulus * stimulus;
  const sum = s2 + theta * theta;
  if (Number.isFinite(sum)) return s2 / sum;
  // Squares overflowed: use the equivalent ratio form.
  const r = theta / stimulus;
  return Number.isNaN(r) ? 0.5 : 1 / (1 + r * r);
}

/**
 * Stimulus of an open intent for self-assignment:
 * priority * (1 + ageMinutes / 10) - repulsionWeight * repulsion, floored at 0.
 * repulsionWeight defaults to 1; an intent dated in the future has age 0.
 */
export function stimulus(intent: Intent, now: number, repulsion: number, repulsionWeight = 1): number {
  const ageMinutes = Math.max(0, now - intent.createdAt) / 60_000;
  const s = intent.priority * (1 + ageMinutes / 10) - repulsionWeight * repulsion;
  return s > 0 ? s : 0;
}

export interface Candidate {
  intent: Intent;
  region: string;
  /** Soft repulsion subtracted from the stimulus: claims and danger on the footprint, claims on co-change neighbors. */
  repulsion: number;
  /** Region admission (harvester-ant control): closed regions are skipped. */
  admissionOpen: boolean;
  /**
   * Lateral inhibition: the live claim value other agents hold on this intent's own footprint
   * paths (exact paths, summed). At or above the inhibition threshold the candidate is skipped;
   * below it, it acts only through `repulsion`. Co-change neighbors and directory or glob overlaps
   * never inhibit. Absent counts as 0.
   */
  directClaim?: number;
}

/**
 * Claim value on exactly these footprint paths: `claim` summed over the distinct paths that are
 * keys of `byPath` (a field reading with the caller's own claims removed). Directory and glob
 * claims that only overlap a path, and danger, are not counted; non-finite or negative values count as 0.
 */
export function directClaimOn(byPath: FieldReading["byPath"], footprint: Iterable<Path>): number {
  let total = 0;
  const seen = new Set<Path>();
  for (const path of footprint) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!Object.hasOwn(byPath, path)) continue;
    const claim = byPath[path]?.claim;
    if (typeof claim === "number" && claim > 0 && Number.isFinite(claim)) total += claim;
  }
  return total;
}

/**
 * Lateral inhibition (winner-take-all on a target): true when other agents' live claim on the
 * candidate's own footprint paths is positive and at least `inhibitAt`. Infinity turns it off,
 * 0 (or less) inhibits on any positive claim, NaN means LATERAL_INHIBITION.
 */
export function inhibited(candidate: Pick<Candidate, "directClaim">, inhibitAt: number = LATERAL_INHIBITION): boolean {
  const claim = candidate.directClaim;
  if (typeof claim !== "number" || !(claim > 0)) return false;
  const at = Number.isNaN(inhibitAt) ? LATERAL_INHIBITION : inhibitAt;
  return at !== Number.POSITIVE_INFINITY && claim >= at;
}

/**
 * Pick an intent for an agent with the response-threshold rule. Walks candidates in
 * descending stimulus and accepts each with probability responseProbability(s, theta[region] ?? defaultTheta).
 * Returns null if nothing is accepted. `rand` is injectable for tests.
 *
 * Closed-admission candidates and laterally inhibited ones (see `inhibited`; `inhibitAt` defaults
 * to LATERAL_INHIBITION) are skipped; ties keep input order; `rand` (default Math.random) is
 * called once per candidate walked and accepts when rand() < p; defaultTheta defaults to 1.
 */
export function chooseIntent(
  candidates: Candidate[],
  thresholds: Record<string, number>,
  now: number,
  rand: () => number = Math.random,
  defaultTheta = 1,
  inhibitAt: number = LATERAL_INHIBITION,
): Candidate | null {
  const ranked = candidates
    .filter((c) => c.admissionOpen && !inhibited(c, inhibitAt))
    .map((c) => ({ c, s: stimulus(c.intent, now, c.repulsion) }))
    .sort((a, b) => b.s - a.s);
  for (const { c, s } of ranked) {
    if (rand() < responseProbability(s, thetaFor(thresholds, c.region, defaultTheta))) return c;
  }
  return null;
}

/**
 * Learning: an agent that lands work in a region becomes more eager there (theta *= 0.8, floor 0.1).
 * A missing region starts from 1. Returns a new record; never raises a threshold already below the floor.
 */
export function reinforceThreshold(thresholds: Record<string, number>, region: string): Record<string, number> {
  const theta = thetaFor(thresholds, region, 1);
  const next = Math.min(theta, Math.max(THETA_FLOOR, theta * REINFORCE_FACTOR));
  return { ...thresholds, [region]: next };
}

/**
 * Admission: a region admits one more agent while active agents < max(minAgents, k * landingsPerMin).
 * k defaults to 2 and minAgents to 3; a negative or NaN landing rate counts as 0.
 */
export function admissionOpen(activeAgents: number, landingsPerMin: number, k = 2, minAgents = 3): boolean {
  const rate = landingsPerMin > 0 ? landingsPerMin : 0;
  return activeAgents < Math.max(minAgents, k * rate);
}

/** A region's own threshold, or `fallback` when it is missing or NaN (own keys only, so "constructor" is safe). */
function thetaFor(thresholds: Record<string, number>, region: string, fallback: number): number {
  const theta = Object.hasOwn(thresholds, region) ? thresholds[region] : undefined;
  return typeof theta === "number" && !Number.isNaN(theta) ? theta : fallback;
}

export type { Id };
