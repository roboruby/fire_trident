import type { Id, Intent } from "./types.ts";

/** Bonabeau/Theraulaz/Deneubourg response function: s^2 / (s^2 + theta^2). */
export function responseProbability(stimulus: number, theta: number): number {
  throw new Error("not implemented");
}

/**
 * Stimulus of an open intent for self-assignment:
 * priority * (1 + ageMinutes / 10) - repulsionWeight * repulsion, floored at 0.
 */
export function stimulus(intent: Intent, now: number, repulsion: number, repulsionWeight?: number): number {
  throw new Error("not implemented");
}

export interface Candidate {
  intent: Intent;
  region: string;
  repulsion: number;
  /** Region admission (harvester-ant control): closed regions are skipped. */
  admissionOpen: boolean;
}

/**
 * Pick an intent for an agent with the response-threshold rule. Walks candidates in
 * descending stimulus and accepts each with probability responseProbability(s, theta[region] ?? defaultTheta).
 * Returns null if nothing is accepted. `rand` is injectable for tests.
 */
export function chooseIntent(
  candidates: Candidate[],
  thresholds: Record<string, number>,
  now: number,
  rand?: () => number,
  defaultTheta?: number,
): Candidate | null {
  throw new Error("not implemented");
}

/** Learning: an agent that lands work in a region becomes more eager there (theta *= 0.8, floor 0.1). */
export function reinforceThreshold(thresholds: Record<string, number>, region: string): Record<string, number> {
  throw new Error("not implemented");
}

/** Admission: a region admits new agents only while active agents <= max(minAgents, k * landingsPerMin). */
export function admissionOpen(activeAgents: number, landingsPerMin: number, k?: number, minAgents?: number): boolean {
  throw new Error("not implemented");
}

export type { Id };
