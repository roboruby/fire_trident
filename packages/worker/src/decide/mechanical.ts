import type { CheckResult, Path, Rule } from "@fire_trident/core";
import { importsOf } from "@fire_trident/core";
import { applyReplacement } from "../agents/change.ts";
import { splitLines } from "./diff.ts";
import { sensitiveReason } from "./signals.ts";

/**
 * Deterministic confirmation: facts about a change that need no model.
 * - Import resolution: every relative import specifier the change adds or rewrites is resolved
 *   against the trunk tree (plus the change's own new files), TypeScript-style.
 * - Mechanical proof: a change whose files equal their base text with only import specifiers
 *   rewritten, each still resolving to the same file (or exactly the rule's declared replacement),
 *   that stays inside the intent's footprint, touches no sensitive path and passes the rule
 *   re-check, is proven correct. Such a proof is a confirmation in its own right.
 * Model opinions never override these facts. Pure: the caller supplies which paths exist.
 */

/** Extensions a TypeScript-style resolver tries, in order. */
export const RESOLVE_EXTS: readonly string[] = [".ts", ".tsx", ".d.ts", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
/** A specifier ending in a JavaScript extension may name its TypeScript source. */
const TS_TWINS: Record<string, string[]> = { ".js": [".ts", ".tsx"], ".jsx": [".tsx"], ".mjs": [".mts"], ".cjs": [".cts"] };
const SCRIPT = /\.[cm]?[jt]sx?$/i;

/** Is this specifier relative ("./x", "../y", ".", "..")? */
export function isRelative(specifier: string): boolean {
  return specifier === "." || specifier === ".." || specifier.startsWith("./") || specifier.startsWith("../");
}

/** The repository path a relative specifier points at from `fromFile` (null when not relative or above the root). */
export function specifierTarget(fromFile: Path, specifier: string): Path | null {
  if (!isRelative(specifier)) return null;
  const slash = fromFile.lastIndexOf("/");
  const parts = slash === -1 ? [] : fromFile.slice(0, slash).split("/").filter(Boolean);
  for (const seg of specifier.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join("/");
}

/** Every path whose existence decides how `target` resolves. */
export function resolutionCandidates(target: Path): Path[] {
  const out: Path[] = [];
  if (target !== "") {
    out.push(target);
    for (const ext of RESOLVE_EXTS) out.push(target + ext);
    for (const [js, twins] of Object.entries(TS_TWINS)) if (target.endsWith(js)) for (const t of twins) out.push(target.slice(0, -js.length) + t);
  }
  const base = target === "" ? "index" : `${target}/index`;
  for (const ext of RESOLVE_EXTS) out.push(base + ext);
  return out;
}

/**
 * The file `target` resolves to, TypeScript-style: the path itself, the path plus an extension,
 * a .js name's TypeScript twin, then the directory's index file. A file beside a same-named
 * directory wins. Null when nothing exists.
 */
export function resolveModule(target: Path | null, exists: (p: Path) => boolean): Path | null {
  if (target === null) return null;
  for (const p of resolutionCandidates(target)) if (exists(p)) return p;
  return null;
}

/** One import specifier the change adds or rewrites, with what the tree says about it. */
export interface SpecifierChange {
  path: Path;
  line: number;
  /** The specifier before (null when the import is new). */
  before: string | null;
  after: string;
  /** File the old specifier resolved to. */
  was: Path | null;
  /** File the new specifier resolves to. */
  now: Path | null;
  /** True when the new specifier is relative (resolvable against the tree). */
  relative: boolean;
}

/** Import specifiers that differ between two versions of a file, paired in order when the import count is unchanged. */
export function changedSpecifiers(path: Path, before: string | null, after: string): Array<{ line: number; before: string | null; after: string }> {
  const a = before === null ? [] : importsOf(before);
  const b = importsOf(after);
  if (before !== null && a.length === b.length) {
    return b.flatMap((imp, i) => (imp.specifier !== a[i]!.specifier ? [{ line: imp.line, before: a[i]!.specifier, after: imp.specifier }] : []));
  }
  const old = new Map<string, number>();
  for (const imp of a) old.set(imp.specifier, (old.get(imp.specifier) ?? 0) + 1);
  const out: Array<{ line: number; before: string | null; after: string }> = [];
  for (const imp of b) {
    const n = old.get(imp.specifier) ?? 0;
    if (n > 0) old.set(imp.specifier, n - 1);
    else out.push({ line: imp.line, before: null, after: imp.specifier });
  }
  return out;
}

/** Every path a resolution check of these files needs to know about. */
export function candidatePaths(files: ReadonlyArray<{ path: Path; before: string | null; after: string | null }>): Path[] {
  const out = new Set<Path>();
  for (const f of files) {
    if (f.after === null || !SCRIPT.test(f.path)) continue;
    for (const c of changedSpecifiers(f.path, f.before, f.after)) {
      for (const spec of [c.before, c.after]) {
        const t = spec === null ? null : specifierTarget(f.path, spec);
        if (t !== null) for (const p of resolutionCandidates(t)) out.add(p);
      }
    }
  }
  return [...out];
}

function quoteAt(line: string, spec: string, from: number): { start: number; end: number } | null {
  for (const q of ["'", '"', "`"]) {
    const needle = `${q}${spec}${q}`;
    const i = line.indexOf(needle, from);
    if (i >= 0) return { start: i + 1, end: i + 1 + spec.length };
  }
  return null;
}

/**
 * True when `after` equals `before` except for the given specifier rewrites (same lines, and on
 * every changed line only the quoted specifiers differ).
 */
export function onlySpecifiersChanged(before: string, after: string, changes: ReadonlyArray<{ line: number; before: string | null; after: string }>): boolean {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length !== b.length || changes.some((c) => c.before === null)) return false;
  const byLine = new Map<number, Array<{ before: string; after: string }>>();
  for (const c of changes) {
    const list = byLine.get(c.line) ?? [];
    list.push({ before: c.before!, after: c.after });
    byLine.set(c.line, list);
  }
  for (let i = 0; i < b.length; i++) {
    if (a[i] === b[i]) continue;
    const edits = byLine.get(i + 1);
    if (!edits) return false;
    let line = b[i]!;
    let from = 0;
    for (const e of edits) {
      const at = quoteAt(line, e.after, from);
      if (!at) return false;
      line = line.slice(0, at.start) + e.before + line.slice(at.end);
      from = at.start + e.before.length;
    }
    if (line !== a[i]) return false;
  }
  return true;
}

/** Everything the mechanical check reads. */
export interface MechanicalInput {
  files: ReadonlyArray<{ path: Path; before: string | null; after: string | null; unreadable?: boolean; binary?: boolean }>;
  /** Writes outside the intent's footprint. */
  residual: readonly Path[];
  /** The intent's rule (null for intents without one). */
  rule: Rule | null;
  /** The rule re-check and the other innate checks passed. */
  innateOk: boolean;
  /** Does this file exist after the change (trunk tree plus the change's own writes)? */
  exists: (p: Path) => boolean;
  /** Did it exist before the change (trunk tree)? Defaults to `exists`. */
  existed?: (p: Path) => boolean;
}

/** What the deterministic stage concluded. */
export interface MechanicalResult {
  verdict: "pass" | "fail" | "inconclusive";
  reasons: string[];
  changes: SpecifierChange[];
  /** One plain sentence per checked specifier, for evidence and for model prompts. */
  facts: string[];
  checks: CheckResult[];
}

/** Run the import-resolution facts and the mechanical proof (see the module comment). */
export function mechanicalCheck(x: MechanicalInput): MechanicalResult {
  const existed = x.existed ?? x.exists;
  const changes: SpecifierChange[] = [];
  const failures: string[] = [];
  const facts: string[] = [];
  let proven = 0;
  const unproven: string[] = [];

  for (const f of x.files) {
    if (f.unreadable || f.binary || f.after === null) {
      unproven.push(`${f.path} cannot be read as text`);
      continue;
    }
    const pairs = SCRIPT.test(f.path) ? changedSpecifiers(f.path, f.before, f.after) : [];
    for (const c of pairs) {
      const relative = isRelative(c.after);
      const was = c.before === null ? null : resolveModule(specifierTarget(f.path, c.before), existed);
      const now = relative ? resolveModule(specifierTarget(f.path, c.after), x.exists) : null;
      changes.push({ path: f.path, line: c.line, before: c.before, after: c.after, was, now, relative });
      const where = `${f.path}:${c.line}`;
      const from = c.before === null ? `new import '${c.after}'` : `'${c.before}' -> '${c.after}'`;
      if (!relative) {
        facts.push(`${where} ${from}: not a relative path (not resolved against the tree)`);
        continue;
      }
      if (now === null) {
        const target = specifierTarget(f.path, c.after);
        failures.push(`${where} ${from}: ${target ?? c.after} does not exist in the trunk tree`);
        facts.push(`${where} ${from}: names nothing that exists (no ${target ?? c.after})`);
        continue;
      }
      if (was !== null && was !== now) {
        failures.push(`${where} ${from}: the import moves from ${was} to ${now}, a different module`);
        facts.push(`${where} ${from}: resolves to ${now}, but the old specifier resolved to ${was}: a different module`);
        continue;
      }
      const dirTarget = specifierTarget(f.path, c.before ?? c.after);
      const beside = dirTarget !== null && now !== null && !now.startsWith(`${dirTarget}/`) && RESOLVE_EXTS.some((e) => existed(`${dirTarget}/index${e}`));
      facts.push(
        `${where} ${from}: ${now} exists${was === now ? " and is the file the old specifier resolved to (same module)" : ""}${beside ? `; ${dirTarget}/ is also a directory, and the file wins` : ""}`,
      );
    }

    // The mechanical proof for this file.
    if (f.before === null) {
      unproven.push(`${f.path} is a new file`);
      continue;
    }
    const replacement = x.rule && x.rule.kind === "forbid-pattern" && typeof x.rule.spec.replacement === "string" ? applyReplacement(x.rule, f.before) : null;
    if (replacement !== null && replacement === f.after && replacement !== f.before) {
      proven++;
      continue;
    }
    const mine = changes.filter((c) => c.path === f.path);
    const preserving = mine.length > 0 && mine.every((c) => c.relative && c.before !== null && c.was !== null && c.was === c.now);
    if (preserving && onlySpecifiersChanged(f.before, f.after, pairs)) proven++;
    else unproven.push(mine.length === 0 ? `${f.path} changes more than import specifiers` : `${f.path} is not a pure, module-preserving specifier rewrite`);
  }

  const sensitive = x.files.map((f) => f.path).filter((p) => sensitiveReason(p) !== null);
  const reasons: string[] = [];
  let verdict: MechanicalResult["verdict"];
  if (failures.length > 0) {
    verdict = "fail";
    reasons.push(...failures);
  } else if (!x.rule) {
    verdict = "inconclusive";
    reasons.push("the intent has no rule to prove against");
  } else if (!x.innateOk) {
    verdict = "inconclusive";
    reasons.push("the rule re-check or another innate check failed");
  } else if (x.residual.length > 0) {
    verdict = "inconclusive";
    reasons.push(`writes outside the footprint: ${x.residual.slice(0, 5).join(", ")}`);
  } else if (sensitive.length > 0) {
    verdict = "inconclusive";
    reasons.push(`touches sensitive paths: ${sensitive.slice(0, 5).join(", ")}`);
  } else if (unproven.length > 0 || proven === 0) {
    verdict = "inconclusive";
    reasons.push(...(unproven.length > 0 ? unproven : ["nothing to prove"]));
  } else {
    verdict = "pass";
    reasons.push(`${proven} file${proven === 1 ? "" : "s"} proven: only import specifiers changed, each still resolving to the same file (or exactly the rule's replacement); inside the footprint; no sensitive path; rule re-check passes`);
  }

  const relative = changes.filter((c) => c.relative);
  const checks: CheckResult[] = [];
  if (relative.length > 0) {
    const bad = relative.filter((c) => c.now === null || (c.was !== null && c.was !== c.now));
    checks.push({
      name: "deterministic: imports resolve",
      ok: bad.length === 0,
      ms: 0,
      detail: `${relative.length - bad.length}/${relative.length} changed relative specifier(s) resolve in the trunk tree to the same module${bad.length > 0 ? `; ${failures.slice(0, 3).join("; ")}` : ""}`.slice(0, 1_000),
    });
  }
  checks.push({ name: "deterministic: mechanical proof", ok: verdict === "pass", ms: 0, detail: `${verdict}: ${reasons.join("; ")}`.slice(0, 1_000) });
  return { verdict, reasons, changes, facts, checks };
}
