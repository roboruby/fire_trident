import type { GateVerdict } from "./gate.ts";

/**
 * Review in a colony that has no model to ask: a colony a person owns whose Cloudflare connection runs no models
 * (cloudflare/models.ts). The decide stage runs every deterministic layer as always (innate checks, proofs, danger
 * patterns, protected paths, goal conflicts, tests before landing); where it would ask a model (the reflex, the second
 * opinion), a person decides instead. It fails closed: a deterministic proof still lands a change, and nothing else
 * lands without a person. A deployment without a Workers AI binding never reaches this (its review stays off, as before).
 */

/** The gate rule of that escalation. Nothing was found wrong with the change, so it costs its region no autonomy. */
export const NO_MODEL_RULE = "N1 no model connected";

/** The verdict that puts a change before a person in place of a model's review, with `reason` (the sentence they read). */
export function noModelVerdict(reason: string, was: GateVerdict): GateVerdict {
  return { action: "escalate", layer: "deterministic", p: 1, rule: NO_MODEL_RULE, reasons: [reason], detectors: ["models:off"], damage: was.damage, confirmations: [], confidence: was.confidence, risk: was.risk };
}
