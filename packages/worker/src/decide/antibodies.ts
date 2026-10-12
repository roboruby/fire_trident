import type { Antibody, Path } from "@fire_trident/core";
import { globMatch } from "@fire_trident/core";
import type { DangerClass } from "./danger.ts";
import type { DetectorState } from "./policy.ts";
import { CAPABILITY_PATTERNS } from "./signals.ts";

/**
 * Antibodies: checks learned from human rejections. Each one is a matcher (where and what it
 * applies to) and a yes/no question Clef answers for every later matching proposal. Stored in the
 * colony's SQLite and committed to trunk under .firetrident/antibodies/. Pure helpers: no I/O.
 */

/** Trunk directory that holds one JSON file per antibody. */
export const ANTIBODY_DIR = ".firetrident/antibodies";

/** Trunk path of an antibody's file. */
export function antibodyPath(id: string): Path {
  return `${ANTIBODY_DIR}/${id}.json`;
}

/** Clef question id of an antibody (ids allow letters, digits, '_', '.', '-'). */
export function antibodyQuestionId(id: string): string {
  return `ab.${id.replace(/[^A-Za-z0-9_.-]/g, "_")}`.slice(0, 100);
}

const MAX_MATCH_PATHS = 8;

/** Extra tokens that make a rejected change recognizable beyond the capability patterns. */
const LOGGING_SOURCE = String.raw`\bconsole\.(?:log|info|warn|error|debug|trace)\s*\(`;

/**
 * Matcher for an antibody derived from the rejected change: the directory subtree of each written
 * path (a root file matches itself), and, when its added lines carry capability tokens (secrets,
 * logging, processes, network, eval, skipped tests), a pattern made of those tokens.
 */
export function deriveMatcher(paths: readonly Path[], addedLines: readonly string[]): Antibody["matcher"] {
  const globs: string[] = [];
  for (const p of paths) {
    const slash = p.lastIndexOf("/");
    const g = slash > 0 ? `${p.slice(0, slash)}/**` : p;
    if (!globs.includes(g)) globs.push(g);
    if (globs.length >= MAX_MATCH_PATHS) break;
  }
  const sources: string[] = [];
  const text = addedLines.join("\n");
  for (const c of CAPABILITY_PATTERNS) {
    c.re.lastIndex = 0;
    if (c.re.test(text)) sources.push(c.re.source);
    c.re.lastIndex = 0;
  }
  if (new RegExp(LOGGING_SOURCE).test(text)) sources.push(LOGGING_SOURCE);
  const matcher: Antibody["matcher"] = { paths: globs };
  if (sources.length > 0) matcher.pattern = sources.map((s) => `(?:${s})`).join("|");
  return matcher;
}

/** Does an antibody apply to a proposal writing `paths` with these added lines? */
export function antibodyMatches(ab: Pick<Antibody, "matcher">, paths: readonly Path[], addedLines: readonly string[]): boolean {
  const globs = ab.matcher?.paths ?? [];
  if (globs.length > 0 && !paths.some((p) => globs.some((g) => g === p || globMatch(g, p)))) return false;
  const pattern = ab.matcher?.pattern;
  if (!pattern) return true;
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch {
    return true;
  }
  return addedLines.some((l) => re.test(l));
}

/** A yes/no question from a reviewer's reason when no model can rephrase it. */
export function fallbackQuestion(reason: string): string {
  const r = reason.replace(/\s+/g, " ").trim().replace(/[.?!]+$/, "");
  return r ? `Does this change repeat a problem a reviewer rejected before: ${r}?` : "Does this change repeat a problem a reviewer rejected before?";
}

/** Clean up a model's rephrased question: one line, ends in "?", sane length; null when unusable. */
export function cleanQuestion(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const s = q.replace(/\s+/g, " ").trim();
  if (s.length < 12 || s.length > 300) return null;
  return s.endsWith("?") ? s : `${s}?`;
}

/**
 * Threshold from self-calibration: Clef answers the new question on the rejected change itself
 * (`pSelf`, which should be a clear yes). The threshold sits at 85% of that score, within
 * [0.5, 0.9]. An antibody that cannot recognize its own origin (pSelf < 0.55) starts advisory.
 */
export function calibrateThreshold(pSelf: number | null): { threshold: number; state: DetectorState } {
  if (pSelf === null || !Number.isFinite(pSelf)) return { threshold: 0.7, state: "active" };
  const threshold = Math.round(Math.min(0.9, Math.max(0.5, pSelf * 0.85)) * 100) / 100;
  return { threshold, state: pSelf < 0.55 ? "advisory" : "active" };
}

/** Stable JSON with sorted keys and a trailing newline. */
function stable(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) out[k] = sort((v as Record<string, unknown>)[k]);
      return out;
    }
    return v;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/** The trunk file for an antibody: its definition plus where it came from. Counters stay in the colony. */
export function antibodyFile(ab: Antibody, origin: { reason: string; by: string; proposalId: string; intentTitle?: string }): string {
  return stable({
    schema: "firetrident.antibody/v1",
    id: ab.id,
    colonyId: ab.colonyId,
    origin: ab.origin,
    matcher: ab.matcher,
    question: ab.question,
    threshold: ab.threshold,
    createdAt: new Date(ab.createdAt).toISOString(),
    createdFrom: ab.createdFrom ?? origin.proposalId,
    rejected: { proposal: origin.proposalId, reason: origin.reason, by: origin.by, ...(origin.intentTitle ? { intent: origin.intentTitle } : {}) },
    ...(antibodyAllows(ab).length > 0 ? { allows: antibodyAllows(ab) } : {}),
  });
}

/** Parse an antibody file from trunk (counters start at zero), or null when it is not one. */
export function parseAntibodyFile(text: string, colonyId: string): Antibody | null {
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const m = raw.matcher as { paths?: unknown; pattern?: unknown } | undefined;
  if (raw.schema !== "firetrident.antibody/v1" || typeof raw.id !== "string" || typeof raw.question !== "string" || !m || !Array.isArray(m.paths)) return null;
  const threshold = typeof raw.threshold === "number" && raw.threshold > 0 && raw.threshold <= 1 ? raw.threshold : 0.7;
  const origin = raw.origin === "escaped-failure" || raw.origin === "reviewer" || raw.origin === "vaccine" ? raw.origin : "human-reject";
  const created = typeof raw.createdAt === "string" ? Date.parse(raw.createdAt) : NaN;
  const ab: Antibody = {
    id: raw.id,
    colonyId,
    origin,
    matcher: { paths: m.paths.filter((p): p is string => typeof p === "string").slice(0, MAX_MATCH_PATHS) },
    question: raw.question,
    threshold,
    createdAt: Number.isFinite(created) ? created : Date.now(),
    hits: 0,
    falsePositives: 0,
  };
  if (typeof m.pattern === "string" && m.pattern) ab.matcher.pattern = m.pattern;
  if (typeof raw.createdFrom === "string") ab.createdFrom = raw.createdFrom;
  const allows = antibodyAllows(raw);
  if (allows.length > 0) (ab as AllowingAntibody).allows = allows;
  return ab;
}

const DANGER_CLASSES: readonly DangerClass[] = ["auth", "secret", "capability", "crypto", "ci", "dependency", "test-weakening"];

/**
 * An antibody that tolerates instead of attacking: a reviewed file under .firetrident/antibodies/
 * with `"allows": ["auth", ...]` lets matching changes carry those danger classes without a human
 * gate (they stay danger signals). It is never asked as a Clef question.
 */
export type AllowingAntibody = Antibody & { allows?: DangerClass[] };

/** The danger classes an antibody record or file allows. */
export function antibodyAllows(x: unknown): DangerClass[] {
  const v = (x as { allows?: unknown } | null)?.allows;
  return Array.isArray(v) ? v.filter((c): c is DangerClass => typeof c === "string" && (DANGER_CLASSES as readonly string[]).includes(c)) : [];
}
