import { GOAL_CONFLICT_LANDINGS, GOAL_CONFLICT_WINDOW_MS, globMatch } from "@fire_trident/core";
import type { DangerClass } from "./danger.ts";

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
  /**
   * Let the comment-only proof (decide/comments.ts) confirm a change to existing script files whose code
   * is unchanged outside comments and whitespace (only while `deterministic` is on).
   */
  commentProof: boolean;
  /** System 1: the decision model asked first. */
  reflexModel: string;
  /** System 2 candidates; the first whose family differs from the authoring agent's is used. */
  secondOpinionModels: string[];
  /**
   * Contest jury members (FT_CONTEST_JURY, decide/jury.ts): small models from different families, of which two or three
   * outside the contestants' families are seated in place of the one judge, each asked in both orders.
   */
  juryModels: string[];
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
  /**
   * Danger classes a human explicitly allows without review, optionally only under some paths
   * (globs). Allowed hits stay danger signals: a reviewer's approval is still needed to land.
   */
  dangerAllow: Array<{ cls: DangerClass; paths?: string[] }>;
  /**
   * Paths only a person may change (globs as rules write them, at most 50): a proposal that writes,
   * deletes or renames one goes to a person, whatever its intent, antibodies or the rest of this
   * policy say. A glob also covers everything under a directory it matches.
   */
  protectedPaths: string[];
  /**
   * Goal conflicts (FT_GOAL_CONFLICT, decide/goalconflict.ts): a landing is recent, so that undoing its lines for another
   * intent waits for a person, for this many minutes after it landed and while it is among the colony's newest
   * `goalConflictLandings` landings.
   */
  goalConflictMinutes: number;
  goalConflictLandings: number;
  /**
   * Intent chains (FT_INTENT_CHAIN_GATE, colony/chain.ts): an agent-declared intent with this many agent-declared
   * intents in its ancestry (parent by parent) waits for a person before any agent takes it; 2 holds the third
   * agent-declared intent in a row. With the flag off the number is kept and nothing is held.
   */
  intentChainDepth: number;
  /**
   * The same gate's fan-out: agent-declared intents one agent may declare in an hour before the rest of its
   * declarations wait for a person the same way, however shallow (one agent's intents reach as many agents).
   */
  intentFanout: number;
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
  commentProof: true,
  reflexModel: "@cf/cloudflare/clef",
  secondOpinionModels: ["@cf/google/gemma-4-26b-a4b-it", "@cf/openai/gpt-oss-120b", "@cf/zai-org/glm-4.7-flash"],
  juryModels: ["@cf/google/gemma-4-26b-a4b-it", "@cf/openai/gpt-oss-20b", "@cf/zai-org/glm-4.7-flash"],
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
  dangerAllow: [],
  protectedPaths: [],
  goalConflictMinutes: GOAL_CONFLICT_WINDOW_MS / 60_000,
  goalConflictLandings: GOAL_CONFLICT_LANDINGS,
  intentChainDepth: 2,
  intentFanout: 5,
};

const DANGER_CLASSES: readonly DangerClass[] = ["auth", "secret", "capability", "crypto", "ci", "dependency", "test-weakening"];

/** Valid allowance entries of a policy patch (unknown classes and non-string globs dropped). */
function allowances(v: unknown, fallback: DecidePolicy["dangerAllow"]): DecidePolicy["dangerAllow"] {
  if (!Array.isArray(v)) return fallback;
  const out: DecidePolicy["dangerAllow"] = [];
  for (const e of v.slice(0, 50)) {
    if (!e || typeof e !== "object") continue;
    const cls = (e as { cls?: unknown }).cls;
    if (typeof cls !== "string" || !(DANGER_CLASSES as readonly string[]).includes(cls)) continue;
    const paths = (e as { paths?: unknown }).paths;
    const globs = Array.isArray(paths) ? paths.filter((g): g is string => typeof g === "string" && g.trim() !== "").slice(0, 20) : [];
    out.push(globs.length > 0 ? { cls: cls as DangerClass, paths: globs } : { cls: cls as DangerClass });
  }
  return out;
}

/** The most protected paths a colony keeps. */
export const MAX_PROTECTED_PATHS = 50;
/** The longest protected path (a glob). */
const MAX_GLOB_CHARS = 300;

/** A protected glob as the policy keeps it: trimmed, without a leading "./" or "/" or a trailing "/". */
export function normalizeGlob(glob: string): string {
  return glob.trim().replace(/^(?:\.\/|\/)+/, "").replace(/\/+$/, "");
}

/** `glob` with each {a,b} group (as the glob matcher reads them) replaced by its first alternative. */
function firstExpansion(glob: string): string {
  for (let open = glob.indexOf("{"); open !== -1; open = glob.indexOf("{", open + 1)) {
    let depth = 0;
    let close = -1;
    let comma = -1;
    for (let k = open; k < glob.length && close === -1; k++) {
      const c = glob[k];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) close = k;
      else if (c === "," && depth === 1 && comma === -1) comma = k;
    }
    if (close === -1 || comma === -1) continue;
    return glob.slice(0, open) + firstExpansion(glob.slice(open + 1, comma)) + firstExpansion(glob.slice(close + 1));
  }
  return glob;
}

/**
 * Why `glob` cannot be a protected path, or null: it is empty, longer than 300 characters, not one line
 * of text, or has so many {a,b} alternatives that the glob matcher gives up on it (it would protect
 * nothing). The last is found by matching the glob against a path built from it.
 */
export function globProblem(glob: string): string | null {
  const g = normalizeGlob(glob);
  if (g === "") return "a protected path cannot be empty";
  if (g.length > MAX_GLOB_CHARS) return `a protected path has at most ${MAX_GLOB_CHARS} characters`;
  if (/[\x00-\x1f\x7f]/.test(g)) return "a protected path is one line of text";
  if (!globMatch(g, firstExpansion(g).replace(/[*?]/g, "a"))) return "a protected path with this many {a,b} alternatives would match nothing";
  return null;
}

/** Valid protected paths of a policy patch (normalized, each once, at most 50); entries that are not usable globs are dropped. */
function protectedGlobs(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out: string[] = [];
  for (const g of v.slice(0, 500)) {
    if (typeof g !== "string" || globProblem(g) !== null) continue;
    const glob = normalizeGlob(g);
    if (!out.includes(glob)) out.push(glob);
    if (out.length >= MAX_PROTECTED_PATHS) break;
  }
  return out;
}

/**
 * Problems with the fields of a policy patch that mergePolicy would otherwise drop without a word, so a
 * person could believe them set: commentProof that is not a boolean, protectedPaths that is not a list
 * of at most 50 usable globs. Each reads "field: problem". Empty when the patch can be applied.
 */
export function policyProblems(patch: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (patch.commentProof !== undefined && typeof patch.commentProof !== "boolean") out.push("commentProof: must be true or false");
  const globs = patch.protectedPaths;
  if (globs !== undefined) {
    if (!Array.isArray(globs)) {
      out.push("protectedPaths: must be a list of globs");
    } else {
      if (globs.length > MAX_PROTECTED_PATHS) out.push(`protectedPaths: at most ${MAX_PROTECTED_PATHS} globs, got ${globs.length}`);
      globs.slice(0, MAX_PROTECTED_PATHS).forEach((g, k) => {
        const why = typeof g === "string" ? globProblem(g) : "must be a string";
        if (why) out.push(`protectedPaths.${k}: ${why}`);
      });
    }
  }
  return out.slice(0, 10);
}

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
  const jury = Array.isArray(p.juryModels) ? p.juryModels.map((m) => model(m, "")).filter(Boolean) : [];
  return {
    enabled: typeof p.enabled === "boolean" ? p.enabled : base.enabled,
    deterministic: typeof p.deterministic === "boolean" ? p.deterministic : base.deterministic,
    commentProof: typeof p.commentProof === "boolean" ? p.commentProof : base.commentProof,
    reflexModel: model(p.reflexModel, base.reflexModel),
    secondOpinionModels: models.length > 0 ? models.slice(0, 5) : base.secondOpinionModels,
    juryModels: jury.length > 0 ? jury.slice(0, 5) : base.juryModels,
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
    dangerAllow: allowances(p.dangerAllow, base.dangerAllow),
    protectedPaths: protectedGlobs(p.protectedPaths, base.protectedPaths),
    goalConflictMinutes: Math.floor(num(p.goalConflictMinutes, 1, 24 * 60, base.goalConflictMinutes)),
    goalConflictLandings: Math.floor(num(p.goalConflictLandings, 1, 10_000, base.goalConflictLandings)),
    intentChainDepth: Math.floor(num(p.intentChainDepth, 1, 50, base.intentChainDepth)),
    intentFanout: Math.floor(num(p.intentFanout, 1, 1_000, base.intentFanout)),
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
