import type { Id, Intent, Path, Rule } from "@fire_trident/core";
import { ruleApplies } from "@fire_trident/core";
import { antibodyAllows, antibodyMatches, securityAntibody } from "../decide/antibodies.ts";
import type { StoredAntibody } from "../decide/store.ts";
import { oneLine } from "./change.ts";

/**
 * What review will ask of a change, shown to the agent that takes the intent before it writes.
 * Antibodies are checks minted from a person's rejections (decide/antibodies.ts): review asks
 * their questions of every later matching proposal, so an agent that sees them first can avoid
 * the rejected pattern instead of repeating it. Pure: no I/O.
 */

/** Antibody questions shown with one take. */
export const PREVIEW_ANTIBODIES = 5;
/** Rules listed with one take. */
export const PREVIEW_RULES = 10;
/** Characters of one question or rule line. */
const LINE_CHARS = 300;
/** Footprint entries matched; a longer footprint is matched on its first ones. */
const PREVIEW_PATHS = 50;

/** An antibody's question as an agent sees it. */
export interface AntibodyQuestion {
  id: Id;
  question: string;
}

/** What review will ask of a change to an intent's footprint (part of ColonyDO.take's result). */
export interface ReviewPreview {
  /** Questions of the antibodies whose paths cover the footprint, active ones first. */
  antibodies: AntibodyQuestion[];
  /** One line (description and hint) per other colony rule whose scope covers the footprint. */
  rules: string[];
}

function clip(text: string): string {
  return text.length > LINE_CHARS ? `${text.slice(0, LINE_CHARS - 1)}…` : text;
}

/** The antibody's path globs, or null when its stored matcher is unusable. */
function globsOf(s: StoredAntibody): string[] | null {
  const paths = (s.antibody as { matcher?: { paths?: unknown } } | null)?.matcher?.paths;
  return Array.isArray(paths) ? paths.filter((g): g is string => typeof g === "string") : null;
}

/** A rule as one line: its description, then its hint. */
function ruleLine(r: Rule): string {
  const desc = oneLine(typeof r.description === "string" ? r.description : "");
  const hint = typeof r.spec?.hint === "string" ? oneLine(r.spec.hint) : "";
  if (!desc || !hint) return clip(desc || hint);
  return clip(`${/[.!?]$/.test(desc) ? desc : `${desc}.`} ${hint}`);
}

/**
 * The preview for an intent. Antibodies: not off and not tolerating ones (review never asks
 * either), and not security ones (decide/antibodies.ts securityAntibody: their agent is told the
 * class, never the question that would show how to slip past it), whose path globs match a
 * footprint entry; active before advisory, then newest first, each question once, at most
 * PREVIEW_ANTIBODIES. Matching uses paths only: an antibody's added-line pattern cannot be tested
 * before the change exists, so review may ask fewer. Rules: the live ones other than the intent's
 * own whose scope covers a footprint entry, at most PREVIEW_RULES. Undefined when there is nothing
 * to show.
 */
export function reviewPreview(intent: Pick<Intent, "footprint" | "ruleId">, antibodies: readonly StoredAntibody[], rules: readonly Rule[]): ReviewPreview | undefined {
  const footprint = (intent.footprint ?? []).filter((p): p is Path => typeof p === "string" && p !== "").slice(0, PREVIEW_PATHS);
  const covering = antibodies.filter((s) => {
    if (s.state === "off" || antibodyAllows(s.antibody).length > 0 || (s.antibody && securityAntibody(s.antibody))) return false;
    const globs = globsOf(s);
    return globs !== null && antibodyMatches({ matcher: { paths: globs } }, footprint, []);
  });
  // Stable: newest first within each state, as the store lists them.
  covering.sort((a, b) => (a.state === "active" ? 0 : 1) - (b.state === "active" ? 0 : 1));
  const seen = new Set<string>();
  const questions: AntibodyQuestion[] = [];
  for (const s of covering) {
    const q = typeof s.antibody.question === "string" ? clip(oneLine(s.antibody.question)) : "";
    if (!q || typeof s.antibody.id !== "string" || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    questions.push({ id: s.antibody.id, question: q });
    if (questions.length >= PREVIEW_ANTIBODIES) break;
  }
  const lines: string[] = [];
  for (const r of rules) {
    if (lines.length >= PREVIEW_RULES) break;
    if (r.retractedAt || r.id === intent.ruleId || !footprint.some((p) => ruleApplies(r, p))) continue;
    const line = ruleLine(r);
    if (line && !lines.includes(line)) lines.push(line);
  }
  return questions.length > 0 || lines.length > 0 ? { antibodies: questions, rules: lines } : undefined;
}

/**
 * A preview received over RPC, checked and capped (a colony on the previous version sends none;
 * malformed entries are dropped). Undefined when nothing usable is left.
 */
export function cleanPreview(x: unknown): ReviewPreview | undefined {
  if (!x || typeof x !== "object") return undefined;
  const raw = x as { antibodies?: unknown; rules?: unknown };
  const antibodies = (Array.isArray(raw.antibodies) ? raw.antibodies : [])
    .filter((a): a is AntibodyQuestion => !!a && typeof a === "object" && typeof (a as AntibodyQuestion).id === "string" && typeof (a as AntibodyQuestion).question === "string")
    .map((a) => ({ id: a.id, question: clip(oneLine(a.question)) }))
    .filter((a) => a.question !== "")
    .slice(0, PREVIEW_ANTIBODIES);
  const rules = (Array.isArray(raw.rules) ? raw.rules : [])
    .filter((r): r is string => typeof r === "string")
    .map((r) => clip(oneLine(r)))
    .filter(Boolean)
    .slice(0, PREVIEW_RULES);
  return antibodies.length > 0 || rules.length > 0 ? { antibodies, rules } : undefined;
}
