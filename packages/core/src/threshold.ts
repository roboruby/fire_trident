import type { FieldReading, Id, Intent, Path } from "./types.ts";

const REINFORCE_FACTOR = 0.8;
const THETA_FLOOR = 0.1;

/**
 * Lateral inhibition threshold, as a claim value (a fresh claim is worth 1): an open intent one of
 * whose own footprint paths carries at least this much live claim from other agents is not taken.
 * Half a fresh claim: heartbeats keep a working agent's claim above it, while a silent agent's claim
 * (tau = 5 min) falls below it after one half-life, about 3.5 minutes, however many of the intent's
 * files it holds: the strongest single path counts (directClaimOn), not their sum, which holds n
 * shared files for 5 * ln(2n) minutes (the worker sums unless FT_INHIBIT_STRONGEST covers the
 * colony). Suppression, not a lock.
 */
export const LATERAL_INHIBITION = 0.5;

/**
 * Cap on the stimulus's age multiplier (1 + ageMinutes / 10), reached at (AGE_FACTOR_CAP - 1) * 10
 * minutes of age (the worker caps only where FT_AGE_CAP covers the colony). Below it, age lifts an
 * old intent over younger ones as before (anti-starvation); past it the multiplier stops growing, so
 * co-change and import repulsion keep holding an old intent back while the files it is coupled to
 * are claimed, instead of fading against an ever larger age term. Chosen from the simulator
 * (packages/bench/results/2026-10-18-inhibition): 4, reached at 30 minutes, is the smallest cap that
 * left every co-change-only run as uncapped, to within a second (2 and 3 slowed draining), and with
 * import repulsion on it cut the slowest of five drains of 1,500 tasks from 3,743 to 2,360 s (1,000
 * agents) and from 3,201 to 2,549 s (100 agents); 6 did not.
 */
export const AGE_FACTOR_CAP = 4;

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
 * priority * min(1 + ageMinutes / 10, ageCap) - repulsionWeight * repulsion, floored at 0.
 * repulsionWeight defaults to 1; an intent dated in the future has age 0. ageCap defaults to
 * AGE_FACTOR_CAP; Infinity leaves the multiplier uncapped, NaN means the default, and a cap below 1 is 1.
 */
export function stimulus(intent: Intent, now: number, repulsion: number, repulsionWeight = 1, ageCap: number = AGE_FACTOR_CAP): number {
  const ageMinutes = Math.max(0, now - intent.createdAt) / 60_000;
  const s = intent.priority * ageFactor(ageMinutes, ageCap) - repulsionWeight * repulsion;
  return s > 0 ? s : 0;
}

/** The age multiplier: 1 + ageMinutes / 10, at most `cap` (see stimulus for how the cap reads). */
export function ageFactor(ageMinutes: number, cap: number = AGE_FACTOR_CAP): number {
  const max = Number.isNaN(cap) ? AGE_FACTOR_CAP : Math.max(1, cap);
  return Math.min(1 + ageMinutes / 10, max);
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
   * paths (exact paths; the strongest single path, see directClaimOn). At or above the inhibition
   * threshold the candidate is skipped; below it, it acts only through `repulsion`. Co-change
   * neighbors and directory or glob overlaps never inhibit. Absent counts as 0.
   */
  directClaim?: number;
}

/** How the claims on an intent's own paths make one inhibition value: the strongest single path's, or (as before) their sum. */
export type ClaimCombine = "strongest" | "sum";

/**
 * Live claim on each of these footprint paths that is a key of `byPath` (a field reading with the
 * caller's own claims removed), added into `into` (a path met twice counts once). Directory and glob
 * claims that only overlap a path, and danger, are not counted; non-finite or negative values count as 0.
 */
export function claimsByPath(byPath: FieldReading["byPath"], footprint: Iterable<Path>, into: Map<Path, number> = new Map()): Map<Path, number> {
  const seen = new Set<Path>();
  for (const path of footprint) {
    if (seen.has(path)) continue;
    seen.add(path);
    if (!Object.hasOwn(byPath, path)) continue;
    const claim = byPath[path]?.claim;
    if (typeof claim === "number" && claim > 0 && Number.isFinite(claim)) into.set(path, (into.get(path) ?? 0) + claim);
  }
  return into;
}

/**
 * One inhibition value from per-path claims: the strongest single path's claim, so a claim
 * inhibits for as long whether one file or twenty overlap; "sum" adds them, as lateral inhibition
 * did before. Non-finite or negative values count as 0; no claims is 0.
 */
export function combineClaims(claims: Iterable<number>, combine: ClaimCombine = "strongest"): number {
  let out = 0;
  for (const c of claims) {
    if (!(c > 0) || !Number.isFinite(c)) continue;
    out = combine === "sum" ? out + c : Math.max(out, c);
  }
  return out;
}

/**
 * Claim value on exactly these footprint paths: the strongest single path's live claim (or the sum,
 * with "sum") over the distinct paths that are keys of `byPath` (see claimsByPath).
 */
export function directClaimOn(byPath: FieldReading["byPath"], footprint: Iterable<Path>, combine: ClaimCombine = "strongest"): number {
  return combineClaims(claimsByPath(byPath, footprint).values(), combine);
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
 * Returns null if nothing is accepted. The caller supplies `rand` (core is pure).
 *
 * Closed-admission candidates and laterally inhibited ones (see `inhibited`; `inhibitAt` defaults
 * to LATERAL_INHIBITION) are skipped; ties keep input order; `rand` (in [0, 1)) is
 * called once per candidate walked and accepts when rand() < p; defaultTheta defaults to 1;
 * `ageCap` caps the stimulus's age multiplier (default AGE_FACTOR_CAP, Infinity uncapped).
 */
export function chooseIntent(
  candidates: Candidate[],
  thresholds: Record<string, number>,
  now: number,
  rand: () => number,
  defaultTheta = 1,
  inhibitAt: number = LATERAL_INHIBITION,
  ageCap: number = AGE_FACTOR_CAP,
): Candidate | null {
  const ranked = candidates
    .filter((c) => c.admissionOpen && !inhibited(c, inhibitAt))
    .map((c) => ({ c, s: stimulus(c.intent, now, c.repulsion, 1, ageCap) }))
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
