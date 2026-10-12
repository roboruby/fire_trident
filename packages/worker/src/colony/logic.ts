import { pathsOverlap, regionOf } from "@fire_trident/core";
import type { Id, Mark, MarkKind, Path, Rule, Violation } from "@fire_trident/core";

/** Default honest gap statement for proposals that do not supply one. */
export const DEFAULT_NOT_VERIFIED = "Not verified: behavior beyond the checks listed";

/** A filter for RegionDO.clear: every given field must match (paths: any of them). */
export interface ClearFilter {
  agentId?: Id;
  intentId?: Id;
  kind?: MarkKind;
  paths?: Path[];
}

/** One batched field update for a region: clears run first, then deposits. */
export interface FieldOps {
  clear?: ClearFilter[];
  deposit?: Array<Omit<Mark, "id">>;
  /** A landing touched this region (counted once per id for admission). */
  landingId?: Id;
}

/** Normalize a repository path: forward slashes, no leading "./" or "/", no doubled slashes. */
export function normalizePath(p: string): Path {
  let s = p.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  while (s.startsWith("/")) s = s.slice(1);
  return s;
}

/** Normalize a list of paths, dropping empties and duplicates (order kept). */
export function normalizePaths(paths: Iterable<string>): Path[] {
  const out: Path[] = [];
  const seen = new Set<Path>();
  for (const raw of paths) {
    const p = normalizePath(raw);
    if (p === "" || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

/** Group paths by region (first-seen order, duplicates dropped). */
export function groupByRegion(paths: Iterable<Path>, depth: number): Map<string, Path[]> {
  const out = new Map<string, Path[]>();
  const seen = new Set<Path>();
  for (const path of paths) {
    if (seen.has(path)) continue;
    seen.add(path);
    const region = regionOf(path, depth);
    const list = out.get(region);
    if (list) list.push(path);
    else out.set(region, [path]);
  }
  return out;
}

/** The region holding most of these paths; ties go to the earliest. "." when empty. */
export function primaryRegion(paths: Path[], depth: number): string {
  let best = ".";
  let bestCount = 0;
  for (const [region, list] of groupByRegion(paths, depth)) {
    if (list.length > bestCount) {
      best = region;
      bestCount = list.length;
    }
  }
  return best;
}

/** One intent draft for a file that violates a rule. */
export interface ViolationIntentDraft {
  path: Path;
  title: string;
  why: string;
  violations: number;
}

/** The hint string of a rule spec, if any. */
export function ruleHint(rule: Pick<Rule, "spec">): string {
  const hint = rule.spec["hint"];
  return typeof hint === "string" ? hint.trim() : "";
}

/** Title of a rule's intent for one file: "<description> in <path>", without the description's trailing punctuation. */
export function ruleIntentTitle(description: string, path: Path): string {
  const head = description.trim().replace(/[\s.,;:!?…]+$/u, "");
  return `${head || description.trim()} in ${path}`;
}

/**
 * Group a rule's violations by file and draft one intent per file: title
 * "<description> in <path>" (see ruleIntentTitle), why = description + hint +
 * violating line numbers. Excerpts are left out on purpose: they are repository
 * content and the why text ends up in agent prompts.
 */
export function violationIntents(rule: Pick<Rule, "description" | "spec">, violations: Violation[]): ViolationIntentDraft[] {
  const byPath = new Map<Path, number[]>();
  for (const v of violations) {
    const path = normalizePath(v.path);
    if (path === "") continue;
    const lines = byPath.get(path);
    if (lines) lines.push(v.line);
    else byPath.set(path, [v.line]);
  }
  const hint = ruleHint(rule);
  const description = rule.description.trim();
  const drafts: ViolationIntentDraft[] = [];
  for (const [path, lines] of byPath) {
    const sorted = [...new Set(lines)].sort((a, b) => a - b);
    const shown = sorted.slice(0, 20).join(", ") + (sorted.length > 20 ? `, and ${sorted.length - 20} more` : "");
    const parts = [description.endsWith(".") ? description : `${description}.`];
    if (hint) parts.push(`Hint: ${hint}`);
    parts.push(`${lines.length === 1 ? "Violation on line" : `${lines.length} violations on lines`} ${shown}.`);
    drafts.push({ path, title: ruleIntentTitle(description, path), why: parts.join("\n"), violations: lines.length });
  }
  return drafts;
}

/**
 * Field updates grouped by region so a whole operation (a landing, a rule with
 * thousands of violations) costs one RegionDO.apply call per region.
 */
export class FieldBatch {
  readonly byRegion = new Map<string, FieldOps>();

  constructor(private readonly depth: number) {}

  private ops(region: string): FieldOps {
    let ops = this.byRegion.get(region);
    if (!ops) {
      ops = {};
      this.byRegion.set(region, ops);
    }
    return ops;
  }

  /** Deposit one mark of `kind` on each path. */
  deposit(kind: MarkKind, paths: Path[], strength: number, at: number, who: { agentId?: Id; intentId?: Id } = {}): this {
    for (const [region, list] of groupByRegion(paths, this.depth)) {
      const ops = this.ops(region);
      const deposits = (ops.deposit ??= []);
      for (const path of list) {
        const mark: Omit<Mark, "id"> = { kind, path, strength, at };
        if (who.agentId !== undefined) mark.agentId = who.agentId;
        if (who.intentId !== undefined) mark.intentId = who.intentId;
        deposits.push(mark);
      }
    }
    return this;
  }

  /** Clear marks matching `filter` on these paths (routed to each path's region). */
  clear(paths: Path[], filter: Omit<ClearFilter, "paths">): this {
    for (const [region, list] of groupByRegion(paths, this.depth)) {
      (this.ops(region).clear ??= []).push({ ...filter, paths: list });
    }
    return this;
  }

  /** Record that a landing touched these regions. */
  landing(regions: Iterable<string>, landingId: Id): this {
    for (const region of regions) this.ops(region).landingId = landingId;
    return this;
  }

  /** Number of regions with pending work. */
  get size(): number {
    return this.byRegion.size;
  }
}

const PATTERN = /[*?{]|\/$/;

/**
 * How many claimed paths overlap a candidate footprint (each claimed path counts
 * once), matching how field repulsion counts marks. Exact matches are cheap;
 * directory and glob entries fall back to pathsOverlap.
 */
export function overlapCount(claimed: Set<Path>, footprint: Path[]): number {
  let n = 0;
  for (const q of claimed) {
    if (footprint.some((p) => p === q || ((PATTERN.test(p) || PATTERN.test(q)) && pathsOverlap(p, q)))) n++;
  }
  return n;
}

/** Retry hint with +-25% jitter so waiting agents do not stampede. */
export function jitter(ms: number, rand: () => number = Math.random): number {
  return Math.round(ms * (0.75 + rand() * 0.5));
}

/** Turn a colony name into its id: lowercase letters, digits and single dashes, at most 48 chars. */
export function slug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
}
