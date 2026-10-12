/**
 * Tunables of the Decide prong (reflex arc and immune review), one set per colony.
 * Pure: no I/O.
 */

/** Detector lifecycle under probation: counted and gating, recorded only, or no longer asked. */
export type DetectorState = "active" | "advisory" | "off";

/** Everything the reflex arc and the gate read from configuration. */
export interface DecidePolicy {
  /** Run the reflex arc on proposals (also needs the AI binding). */
  enabled: boolean;
  /** Let a mechanical proof (decide/mechanical.ts) confirm a change without any model. */
  deterministic: boolean;
  /** System 1: the decision model asked first. */
  reflexModel: string;
  /** System 2 candidates; the first whose family differs from the authoring agent's is used. */
  secondOpinionModels: string[];
  /** A layer acts alone when the answers that decide are at least this confident (|2p - 1| for yes/no answers). */
  confidence: number;
  /** A yes/no detector answer at or above this probability is a hit. */
  hit: number;
  /** p(needs_human) must be below this for a proposal to land. */
  needsHuman: number;
  /** Human escalations allowed per rolling hour before low-risk ones go back to their agents. */
  alertsPerHour: number;
  /** Escalations at or above this risk (0 none, 1 low, 2 medium, 3 high) still reach humans when the budget is spent. */
  budgetRiskFloor: number;
  /** Landings approved by a higher layer in a region before the reflex may land there alone. */
  autonomyAfter: number;
  /** Detector probation: not useful at least `advisory` of the time → advisory; more than `off` → off; after `minFires` fires. */
  probation: { advisory: number; off: number; minFires: number };
  /** Matching antibodies asked per proposal (one Clef call takes 64 questions; 4 are the standard ones). */
  maxAntibodies: number;
  /** System 2 calls in flight at once, per colony. */
  llmConcurrency: number;
  /** System 2 calls started per minute, per colony and model (Workers AI allows 300, or 20 for models that need Workers Paid). */
  llmPerMinute: number;
}

/**
 * Defaults. Clef (27B) separates clean from bad changes far better than clef-flash on this task.
 * System 2 models answer fast and get Workers AI's default 300 requests a minute (models that need
 * Workers Paid get 20, which stalls a swarm): gemma-4-26b answers in 1-2 s; gpt-oss-120b covers
 * authors from the Gemma family.
 */
export const DEFAULT_POLICY: DecidePolicy = {
  enabled: true,
  deterministic: true,
  reflexModel: "@cf/cloudflare/clef",
  secondOpinionModels: ["@cf/google/gemma-4-26b-a4b-it", "@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-4.7-flash"],
  confidence: 0.8,
  hit: 0.5,
  needsHuman: 0.5,
  alertsPerHour: 30,
  budgetRiskFloor: 2,
  autonomyAfter: 3,
  probation: { advisory: 0.1, off: 0.25, minFires: 5 },
  maxAntibodies: 60,
  llmConcurrency: 8,
  llmPerMinute: 120,
};

function num(v: unknown, lo: number, hi: number, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;
}

function model(v: unknown, fallback: string): string {
  return typeof v === "string" && /^@?[\w.-]+(?:\/[\w.-]+)*$/.test(v.trim()) ? v.trim() : fallback;
}

/** `base` with the valid fields of `patch` applied (numbers clamped, unknown keys ignored). */
export function mergePolicy(base: DecidePolicy, patch: unknown): DecidePolicy {
  if (!patch || typeof patch !== "object") return base;
  const p = patch as Record<string, unknown>;
  const prob = (p.probation && typeof p.probation === "object" ? p.probation : {}) as Record<string, unknown>;
  const models = Array.isArray(p.secondOpinionModels) ? p.secondOpinionModels.map((m) => model(m, "")).filter(Boolean) : [];
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
    deterministic: typeof p.deterministic === "boolean" ? p.deterministic : base.deterministic,
    reflexModel: model(p.reflexModel, base.reflexModel),
    secondOpinionModels: models.length > 0 ? models.slice(0, 5) : base.secondOpinionModels,
    confidence: num(p.confidence, 0, 1, base.confidence),
    hit: num(p.hit, 0.05, 0.99, base.hit),
    needsHuman: num(p.needsHuman, 0.01, 1, base.needsHuman),
    alertsPerHour: Math.floor(num(p.alertsPerHour, 0, 10_000, base.alertsPerHour)),
    budgetRiskFloor: num(p.budgetRiskFloor, 0, 3, base.budgetRiskFloor),
    autonomyAfter: Math.floor(num(p.autonomyAfter, 1, 1_000, base.autonomyAfter)),
    probation: {
      advisory: num(prob.advisory, 0, 1, base.probation.advisory),
      off: num(prob.off, 0, 1, base.probation.off),
      minFires: Math.floor(num(prob.minFires, 1, 10_000, base.probation.minFires)),
    },
    maxAntibodies: Math.floor(num(p.maxAntibodies, 0, 60, base.maxAntibodies)),
    llmConcurrency: Math.floor(num(p.llmConcurrency, 1, 64, base.llmConcurrency)),
    llmPerMinute: Math.floor(num(p.llmPerMinute, 1, 3_000, base.llmPerMinute)),
  };
}

/**
 * Model family: the vendor segment of a Workers AI id ("@cf/openai/gpt-oss-120b" → "openai"),
 * "anthropic" for claude-* ids, otherwise the id itself (lowercased).
 */
export function modelFamily(id: string | undefined | null): string {
  const m = (id ?? "").trim().toLowerCase();
  if (m === "") return "";
  if (m.startsWith("claude-")) return "anthropic";
  const parts = m.split("/").filter(Boolean);
  if (parts[0]?.startsWith("@") && parts.length >= 3) return parts[1]!;
  return parts.length >= 2 ? parts[0]!.replace(/^@/, "") : m;
}

/** The System 2 model for a change written by `authorModel`: the first candidate from a different family. */
export function pickSecondOpinion(authorModel: string | undefined, candidates: readonly string[]): string {
  return secondOpinionCandidates(authorModel, candidates)[0] ?? DEFAULT_POLICY.secondOpinionModels[0]!;
}

/** System 2 models to try, in order: every candidate from a different family than the author's (all of them when none is). */
export function secondOpinionCandidates(authorModel: string | undefined, candidates: readonly string[]): string[] {
  const author = modelFamily(authorModel);
  const other = candidates.filter((c) => modelFamily(c) !== author);
  return [...new Set(other.length > 0 ? other : candidates)];
}

/**
 * Probation for a detector: after `minFires` fires, marked not useful at least `advisory` of the
 * time → advisory (recorded, no longer gating); more than `off` of the time → off (not asked).
 */
export function probationState(fires: number, notUseful: number, p: DecidePolicy["probation"]): DetectorState {
  if (fires < p.minFires || fires <= 0) return "active";
  const rate = notUseful / fires;
  if (rate > p.off) return "off";
  if (rate >= p.advisory) return "advisory";
  return "active";
}
