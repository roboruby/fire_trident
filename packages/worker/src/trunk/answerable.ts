import { landingAnswerable } from "@fire_trident/core";
import type { CheckResult, Id, Intent, IntentSource, Landing, LandingAnswer, LineageNote } from "@fire_trident/core";

/**
 * Who answers for a landing, as the worker records it. The colony hands the trunk writer, in the land context, who
 * declared each intent (its source and creator) and, for a rule's intent, who approved the rule; the trunk writer puts
 * them in the lineage note (additive fields: older notes lack them and still verify, since a digest covers a note as it
 * was written) and marks the landing with the note's answer (core/answerable.ts), which the colony counts for its
 * metrics. The colony also marks the checks an agent sends with its change as the agent's own claims. Pure: no I/O.
 */

/** Who declared an intent and who approved its rule, as a lineage note records them. */
export interface IntentWho {
  source?: IntentSource;
  createdBy?: string;
  ruleApprovedBy?: string;
}

/** Longest name a note keeps for who declared an intent or approved a rule. */
const WHO_CHARS = 200;
const SOURCES: ReadonlySet<string> = new Set<IntentSource>(["human", "rule", "agent", "certify", "system"]);

/** One line, at most WHO_CHARS; undefined when not a string. */
function who(raw: unknown): string | undefined {
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, WHO_CHARS) : undefined;
}

/**
 * The intent's who-fields as its lineage note keeps them: `source` when it is one the colony knows, `createdBy`, and
 * `ruleApprovedBy` only for an intent made from a rule; each left out when not known.
 */
export function noteIntentWho(i: (IntentWho & { ruleId?: Id }) | undefined): IntentWho {
  if (!i) return {};
  const source = typeof i.source === "string" && SOURCES.has(i.source) ? i.source : undefined;
  const createdBy = who(i.createdBy);
  const approvedBy = i.ruleId ? who(i.ruleApprovedBy) : undefined;
  return { ...(source ? { source } : {}), ...(createdBy !== undefined ? { createdBy } : {}), ...(approvedBy !== undefined ? { ruleApprovedBy: approvedBy } : {}) };
}

/** The land context's who-fields for one intent (ColonyDO.landContext): its source, its creator, and its rule's approver when the colony has the rule. */
export function intentWho(i: Pick<Intent, "source" | "createdBy" | "ruleId">, ruleApprover: (ruleId: Id) => string | null | undefined): IntentWho {
  const approvedBy = i.ruleId ? ruleApprover(i.ruleId) : undefined;
  return { source: i.source, createdBy: i.createdBy, ...(typeof approvedBy === "string" ? { ruleApprovedBy: approvedBy } : {}) };
}

/** A landing's answer from the lineage note the trunk writer writes for it. */
export function landingAnswer(note: LineageNote): LandingAnswer {
  return landingAnswerable(note).answer;
}

/** The checks a proposal came with, each marked as the agent's own claim (Evidence checks, `by: "agent"`). */
export function agentClaims(checks: unknown): CheckResult[] {
  return Array.isArray(checks) ? checks.map((c: CheckResult) => (c && typeof c === "object" ? { ...c, by: "agent" as const } : c)) : [];
}

/** The colony's counters for the meter: landings whose note gave an answer, and of them those no person answers for, and those it cannot say. */
export const ANSWERABLE_COUNTERS = { landings: "answerable.landings", none: "answerable.none", unknown: "answerable.unknown" } as const;

/** What one landing adds to the meter's counters (nothing for a landing recorded before landings carried an answer). */
export function answerableBumps(l: Pick<Landing, "answerable"> | null | undefined): Array<[string, number]> {
  const a = l?.answerable;
  if (a !== "person" && a !== "none" && a !== "unknown") return [];
  return [[ANSWERABLE_COUNTERS.landings, 1], ...(a === "none" ? [[ANSWERABLE_COUNTERS.none, 1] as [string, number]] : []), ...(a === "unknown" ? [[ANSWERABLE_COUNTERS.unknown, 1] as [string, number]] : [])];
}

/**
 * The meter GET /api/colonies/:id/metrics serves as `answerable`: of the landings counted since landings carried an
 * answer, how many no person is answerable for (`none`, and `share` of them), and how many notes could not say (`unknown`).
 */
export interface AnswerableMeter {
  landings: number;
  none: number;
  unknown: number;
  /** none / landings, rounded to 4 places; null before any landing was counted. */
  share: number | null;
}

/** The meter from the colony's counters. */
export function answerableMeter(metrics: Readonly<Record<string, number>>): AnswerableMeter {
  const n = (k: string): number => (typeof metrics[k] === "number" && Number.isFinite(metrics[k]) && metrics[k]! > 0 ? Math.floor(metrics[k]!) : 0);
  const landings = n(ANSWERABLE_COUNTERS.landings);
  const none = Math.min(n(ANSWERABLE_COUNTERS.none), landings);
  return { landings, none, unknown: Math.min(n(ANSWERABLE_COUNTERS.unknown), landings), share: landings > 0 ? Math.round((none / landings) * 10_000) / 10_000 : null };
}
