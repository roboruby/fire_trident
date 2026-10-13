import type { CheckResult, NameAssumption, Path, Rule } from "@fire_trident/core";
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
 * - Name assumptions: the names each written file imports from the trunk files its relative imports
 *   resolve to, and a reader of the names a file exports, so the trunk writer can land a change whose
 *   read file changed when the names it relies on still hold (assumption revalidation).
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

/** The most assumptions one proposal records (each is one existence check at landing). */
export const MAX_ASSUMPTIONS = 200;

/**
 * The trunk files a change's resolved relative imports point at, outside its own writes: what the
 * deterministic facts ("x exists") rely on, re-checked when the change lands.
 */
export function proofAssumptions(changes: readonly SpecifierChange[], ownWrites: ReadonlySet<Path>): Path[] {
  const out = new Set<Path>();
  for (const c of changes) if (c.relative && c.now !== null && !ownWrites.has(c.now)) out.add(c.now);
  return [...out].sort().slice(0, MAX_ASSUMPTIONS);
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

// ---------------------------------------------------------------------------
// Name assumptions: the names a change imports from trunk files, and the names a file exports
// ---------------------------------------------------------------------------

/** Files that embed module imports this stage does not read: a change writing one records no name assumptions. */
const EMBEDS_IMPORTS = /\.(?:vue|svelte|astro|mdx|html?|marko)$/i;
/** The most names one name assumption holds; a file the change imports more names from is left uncovered. */
export const MAX_ASSUMPTION_NAMES = 200;

/** One static import, re-export from, dynamic import or require of a module, with the names it takes (null: none that can be checked). */
export interface ImportBinding {
  specifier: string;
  line: number;
  names: string[] | null;
}

/**
 * The imports of a JS/TS source with the names each takes from its module: named imports by the name
 * the module exports (`{ a as b }` takes `a`), `default` for a default import, and the names of
 * `export { x } from`. A namespace import, `export * from`, a side-effect import, a dynamic import, a
 * require or `import {} from` takes no names that can be checked (names null). The list is exactly the
 * imports `importsOf` reports, line for line; one whose clause this reader cannot parse gets names null.
 */
export function importBindings(source: string): ImportBinding[] {
  const parsed = new Map<string, Array<string[] | null>>();
  for (const b of parseBindings(tokenize(source))) {
    const key = `${b.specifier}\u0000${b.line}`;
    const list = parsed.get(key) ?? [];
    list.push(b.names);
    parsed.set(key, list);
  }
  return importsOf(source).map((imp) => {
    const names = parsed.get(`${imp.specifier}\u0000${imp.line}`)?.shift();
    return { specifier: imp.specifier, line: imp.line, names: names ?? null };
  });
}

/** What a module exports by name. `star`: specifiers of `export * from`, whose names are not listed. */
export interface ModuleExports {
  names: Set<string>;
  star: string[];
}

/**
 * The names a JS/TS source exports at its top level: `export function|class|const|let|var|interface|
 * type|enum|namespace` (also `declare`, `async`, `abstract` and `const enum` forms; for const, let and
 * var only the first plain name of the declaration), `export default` (as "default"), `export { a, b
 * as c }` with or without `from` (a and c), `export * as ns from` (ns) and `export import A =`.
 * `export * from` is listed in `star`. Null when the source cannot be read reliably (an unterminated
 * string or template, unbalanced braces, or `export =`), so nothing is ever taken as exported by mistake.
 */
export function exportedNames(source: string): ModuleExports | null {
  const t = tokenize(source);
  if (t.some((x) => x.kind === "bad")) return null;
  const names = new Set<string>();
  const star: string[] = [];
  const punc = (k: number, value: string): boolean => t[k]?.kind === "punc" && t[k]?.value === value;
  const word = (k: number, value: string): boolean => t[k]?.kind === "id" && t[k]?.value === value;
  const name = (k: number): boolean => t[k]?.kind === "id";
  let depth = 0;
  for (let k = 0; k < t.length; k++) {
    const tok = t[k]!;
    if (tok.kind === "punc") {
      if (tok.value === "{") depth++;
      else if (tok.value === "}" && --depth < 0) return null;
      continue;
    }
    if (depth !== 0 || tok.kind !== "id" || tok.value !== "export" || punc(k - 1, ".")) continue;
    // Only at the start of a statement: after ";" or "}", or on a new line.
    const prev = t[k - 1];
    if (prev && prev.line === tok.line && !(prev.kind === "punc" && (prev.value === ";" || prev.value === "}"))) continue;
    let j = k + 1;
    if (word(j, "default")) {
      names.add("default");
      continue;
    }
    if (punc(j, "=")) return null; // export = x: a CommonJS-style module, whose named exports cannot be read
    if (word(j, "declare")) j++;
    if (word(j, "type") && (punc(j + 1, "{") || punc(j + 1, "*"))) j++;
    if (punc(j, "{")) {
      const close = closingBrace(t, j);
      for (const e of close === -1 ? [] : (listEntries(t, j, close) ?? [])) names.add(e.alias ?? e.name);
      continue;
    }
    if (punc(j, "*")) {
      if (word(j + 1, "as") && (name(j + 2) || t[j + 2]?.kind === "str")) names.add(t[j + 2]!.value);
      else if (word(j + 1, "from") && t[j + 2]?.kind === "str") star.push(t[j + 2]!.value);
      continue;
    }
    if (word(j, "import")) {
      if (name(j + 1) && punc(j + 2, "=")) names.add(t[j + 1]!.value);
      continue;
    }
    if (word(j, "async") || word(j, "abstract")) j++;
    if (word(j, "const") && word(j + 1, "enum")) j++;
    const kw = t[j];
    if (kw?.kind !== "id") continue;
    if (kw.value === "function") {
      const at = punc(j + 1, "*") ? j + 2 : j + 1;
      if (name(at)) names.add(t[at]!.value);
    } else if (DECLARES.has(kw.value) && name(j + 1)) {
      names.add(t[j + 1]!.value);
    }
  }
  return depth === 0 ? { names, star } : null;
}

/** Keywords after `export` that declare one name next. */
const DECLARES: ReadonlySet<string> = new Set(["class", "const", "let", "var", "interface", "type", "enum", "namespace", "module"]);

/** Every path a name-assumption resolution of these files needs to know about (each relative import of each written script). */
export function nameAssumptionCandidates(files: ReadonlyArray<{ path: Path; after: string | null }>): Path[] {
  const out = new Set<Path>();
  for (const f of files) {
    if (f.after === null || !SCRIPT.test(f.path)) continue;
    for (const imp of importsOf(f.after)) {
      const t = specifierTarget(f.path, imp.specifier);
      if (t !== null) for (const p of resolutionCandidates(t)) out.add(p);
    }
  }
  return [...out];
}

/**
 * Name assumptions of a change (Proposal.nameAssumptions): for every relative import of a file it writes that
 * resolves to a trunk file it does not write, the names imported from that file. A file stays uncovered
 * (no assumption) when an import of it takes no checkable names (namespace, side effect, dynamic, require,
 * `export *`), when it is not a script, when it is a sensitive path (auth, secrets, CI, manifests: a
 * change that read one that moved always goes back), when it takes more than MAX_ASSUMPTION_NAMES names,
 * or when a non-relative import of the change could name it through a path alias. A written file this stage
 * cannot read, or one that embeds imports it does not parse (.vue, .svelte, .html, ...), means no
 * assumptions at all. `exists` is the tree after the change, `existed` the trunk tree.
 */
export function nameAssumptions(
  files: ReadonlyArray<{ path: Path; after: string | null; unreadable?: boolean; binary?: boolean }>,
  exists: (p: Path) => boolean,
  existed: (p: Path) => boolean,
): NameAssumption[] {
  const own = new Set(files.map((f) => f.path));
  const names = new Map<Path, Set<string>>();
  const uncovered = new Set<Path>();
  const loose: string[] = [];
  for (const f of files) {
    if (f.after === null) {
      if (f.unreadable || f.binary) return [];
      continue;
    }
    if (EMBEDS_IMPORTS.test(f.path)) return [];
    if (!SCRIPT.test(f.path)) continue;
    for (const b of importBindings(f.after)) {
      if (!isRelative(b.specifier)) {
        loose.push(b.specifier);
        continue;
      }
      const target = resolveModule(specifierTarget(f.path, b.specifier), exists);
      if (target === null || own.has(target) || !existed(target)) continue;
      if (b.names === null || !SCRIPT.test(target) || sensitiveReason(target) !== null) {
        uncovered.add(target);
        continue;
      }
      const set = names.get(target) ?? new Set<string>();
      for (const n of b.names) set.add(n);
      names.set(target, set);
    }
  }
  const out: NameAssumption[] = [];
  for (const path of [...names.keys()].sort()) {
    const set = names.get(path)!;
    if (uncovered.has(path) || set.size > MAX_ASSUMPTION_NAMES || loose.some((s) => mayName(s, path))) continue;
    out.push({ path, names: [...set].sort() });
    if (out.length >= MAX_ASSUMPTIONS) break;
  }
  return out;
}

/**
 * Could a non-relative specifier name `target` through a path alias ("@/lib/x", "~/x", "#lib/x") or a
 * base URL ("lib/x")? A loose suffix match on the module path, so a package import rarely matches and an
 * alias that might never slips through. "#x", "@x" or "~x" with no slash is an alias that may point
 * anywhere: it matches every target. Node built-ins never match.
 */
function mayName(specifier: string, target: Path): boolean {
  if (specifier.startsWith("node:")) return false;
  const bare = specifier.replace(/\.(?:d\.)?[cm]?[jt]sx?$/i, "").replace(/\/+$/, "");
  if (/^[#@~][^/]*$/.test(bare)) return true;
  const tails = [bare];
  const aliased = /^(?:[@~#][^/]*\/|\/+)(.+)$/.exec(bare);
  if (aliased) tails.push(aliased[1]!);
  const module = target.replace(/\.(?:d\.)?[cm]?[jt]sx?$/i, "");
  const keys = module.endsWith("/index") ? [module, module.slice(0, -"/index".length)] : [module];
  return tails.some((tail) => tail !== "" && keys.some((k) => k === tail || k.endsWith(`/${tail}`)));
}

/** Imports with the names they take, from tokens (the same statements `importsOf` recognizes). */
function parseBindings(t: Token[]): ImportBinding[] {
  const out: ImportBinding[] = [];
  const punc = (k: number, value: string): boolean => t[k]?.kind === "punc" && t[k]?.value === value;
  const word = (k: number, value: string): boolean => t[k]?.kind === "id" && t[k]?.value === value;
  const str = (k: number): boolean => t[k]?.kind === "str";
  const add = (k: number, names: string[] | null): void => {
    out.push({ specifier: t[k]!.value, line: t[k]!.line, names: names !== null && names.length > 0 ? names : null });
  };
  for (let k = 0; k < t.length; k++) {
    const tok = t[k]!;
    if (tok.kind !== "id" || punc(k - 1, ".")) continue;
    if (tok.value === "require") {
      if (punc(k + 1, "(") && str(k + 2) && punc(k + 3, ")")) add(k + 2, null);
    } else if (tok.value === "import") {
      if (punc(k + 1, "(")) {
        if (str(k + 2) && (punc(k + 3, ")") || punc(k + 3, ","))) add(k + 2, null);
      } else if (str(k + 1)) {
        add(k + 1, null);
      } else {
        const at = clauseSpecifier(t, k + 1);
        if (at !== -1) add(at, clauseNames(t, k + 1, at - 1));
      }
    } else if (tok.value === "export") {
      let j = k + 1;
      if (word(j, "type")) j++;
      if (punc(j, "*")) {
        j++;
        if (word(j, "as")) j += 2;
        if (word(j, "from") && str(j + 1)) add(j + 1, null);
      } else if (punc(j, "{")) {
        const close = closingBrace(t, j);
        if (close !== -1 && word(close + 1, "from") && str(close + 2)) add(close + 2, listEntries(t, j, close)?.map((e) => e.name) ?? null);
      }
    }
  }
  return out;
}

/**
 * The names an import clause (tokens `start` to `end`, exclusive, before `from`) takes: `default` for a
 * default binding, the module's names in braces. Null for a namespace import or a clause that is not
 * one of the plain forms (`[type] X`, `[type] { ... }`, `X, { ... }`, `[type] * as ns`, `X, * as ns`).
 */
function clauseNames(t: Token[], start: number, end: number): string[] | null {
  let i = start;
  // `type` is the type-only marker unless it is the default binding itself (`import type from`, `import type, {`).
  if (t[i]?.kind === "id" && t[i]!.value === "type" && i + 1 < end && !(t[i + 1]!.kind === "punc" && t[i + 1]!.value === ",")) i++;
  const names: string[] = [];
  if (i < end && t[i]!.kind === "id") {
    names.push("default");
    i++;
    if (i === end) return names;
    if (!(t[i]!.kind === "punc" && t[i]!.value === ",")) return null;
    i++;
  }
  if (i < end && t[i]!.kind === "punc" && t[i]!.value === "{") {
    const close = closingBrace(t, i);
    if (close !== end - 1) return null;
    const entries = listEntries(t, i, close);
    if (entries === null) return null;
    names.push(...entries.map((e) => e.name));
    return names;
  }
  return null;
}

/**
 * Entries of a `{ ... }` import or export list (tokens `open` to `close`): `name`, `name as alias`, with
 * an optional `type` modifier; names may be strings. Null when an entry has any other shape.
 */
function listEntries(t: Token[], open: number, close: number): Array<{ name: string; alias?: string }> | null {
  const out: Array<{ name: string; alias?: string }> = [];
  let entry: Token[] = [];
  const flush = (): boolean => {
    let e = entry;
    entry = [];
    if (e.length === 0) return true;
    if (e.length > 1 && e[0]!.kind === "id" && e[0]!.value === "type") {
      // `type as x` could be the name `type` or a type-only `as`: too ambiguous to rely on.
      if (e[1]!.kind === "id" && e[1]!.value === "as") return false;
      e = e.slice(1);
    }
    const ok = (x: Token | undefined): boolean => x !== undefined && (x.kind === "id" || x.kind === "str");
    if (e.length === 1 && ok(e[0])) out.push({ name: e[0]!.value });
    else if (e.length === 3 && ok(e[0]) && e[1]!.kind === "id" && e[1]!.value === "as" && ok(e[2])) out.push({ name: e[0]!.value, alias: e[2]!.value });
    else return false;
    return true;
  };
  for (let j = open + 1; j < close; j++) {
    const tok = t[j]!;
    if (tok.kind === "punc" && tok.value === ",") {
      if (!flush()) return null;
    } else {
      entry.push(tok);
    }
  }
  return flush() ? out : null;
}

type TokenKind = "id" | "num" | "str" | "tpl" | "re" | "punc" | "bad";

/** A lexer token; "str" is a quoted string or a template without substitutions (value unescaped). */
interface Token {
  kind: TokenKind;
  value: string;
  line: number;
}

const CLAUSE_PUNC = new Set([",", "{", "}", "*"]);
const CLAUSE_LIMIT = 4096;

/** Index of the specifier token ending an import clause starting at `start` (`... from "m"`), or -1 (as core's importsOf decides). */
function clauseSpecifier(t: Token[], start: number): number {
  let depth = 0;
  for (let j = start; j < t.length && j < start + CLAUSE_LIMIT; j++) {
    const tok = t[j]!;
    if (tok.kind === "id") {
      if (tok.value === "from" && t[j + 1]?.kind === "str") return j + 1;
    } else if (tok.kind === "punc" && CLAUSE_PUNC.has(tok.value)) {
      if (tok.value === "{") depth++;
      else if (tok.value === "}") depth--;
    } else if (!(tok.kind === "str" && depth > 0)) {
      return -1;
    }
  }
  return -1;
}

/** Index of the "}" matching the "{" at `open`, or -1. */
function closingBrace(t: Token[], open: number): number {
  let depth = 0;
  for (let j = open; j < t.length; j++) {
    const tok = t[j]!;
    if (tok.kind !== "punc") continue;
    if (tok.value === "{") depth++;
    else if (tok.value === "}" && --depth === 0) return j;
  }
  return -1;
}

const SPACE = /\s/;
const DIGIT = /[0-9]/;
const ID_START = /[A-Za-z_$\u0080-￿]/;
const ID_PART = /[A-Za-z0-9_$\u0080-￿]/;
const NUMBER_PART = /[0-9A-Za-z_.]/;
/** Keywords after which "/" starts a regex literal rather than a division. */
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);

function unescape(raw: string): string {
  return raw.replace(/\\(\r\n|[\s\S])/g, (_m, c: string) => (c === "\n" || c === "\r" || c === "\r\n" || c === " " || c === " " ? "" : c));
}

/**
 * Tokenize JS/TS the way core's `importsOf` does (the same lines, the same strings), so every import it
 * reports can be matched with the names read here: skips comments, keeps string values, treats template
 * text and regex literals as opaque, and tracks lines (\n, \r\n, \r). Never throws; unterminated strings
 * and templates become "bad" tokens.
 */
function tokenize(src: string): Token[] {
  const out: Token[] = [];
  const braces: boolean[] = []; // per open "{": true when it opened a template substitution
  const n = src.length;
  let i = 0;
  let line = 1;

  const breakLen = (j: number): number => (src[j] === "\n" ? 1 : src[j] === "\r" ? (src[j + 1] === "\n" ? 2 : 1) : 0);
  const countLines = (from: number, to: number): void => {
    for (let j = from; j < to; ) {
      const b = breakLen(j);
      if (b > 0) {
        line++;
        j += b;
      } else {
        j++;
      }
    }
  };
  // Template text from `start` (after "`" or a substitution's "}") to the closing "`" or the next "${".
  const template = (start: number, startLine: number, substituted: boolean): void => {
    for (let j = start; j < n; j++) {
      const c = src[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "`") {
        countLines(start, j);
        out.push(substituted ? { kind: "tpl", value: "", line } : { kind: "str", value: unescape(src.slice(start, j)), line: startLine });
        i = j + 1;
        return;
      }
      if (c === "$" && src[j + 1] === "{") {
        countLines(start, j);
        out.push({ kind: "punc", value: "${", line });
        braces.push(true);
        i = j + 2;
        return;
      }
    }
    countLines(start, n);
    out.push({ kind: "bad", value: "", line: startLine });
    i = n;
  };
  const regexAllowed = (): boolean => {
    const prev = out[out.length - 1];
    if (prev === undefined) return true;
    if (prev.kind === "punc") return prev.value !== ")" && prev.value !== "]";
    return prev.kind === "id" && REGEX_AFTER.has(prev.value);
  };
  // End index of a regex literal starting at `start` (flags included), or -1 if the line ends first.
  const regexEnd = (start: number): number => {
    let inClass = false;
    for (let j = start + 1; j < n; j++) {
      const c = src[j];
      if (breakLen(j) > 0) return -1;
      if (c === "\\") {
        if (breakLen(j + 1) > 0) return -1;
        j++;
      } else if (c === "[") {
        inClass = true;
      } else if (c === "]") {
        inClass = false;
      } else if (c === "/" && !inClass) {
        let end = j + 1;
        while (end < n && ID_PART.test(src[end]!)) end++;
        return end;
      }
    }
    return -1;
  };

  if (src.charCodeAt(0) === 0xfeff) i = 1;
  if (src.startsWith("#!", i)) while (i < n && breakLen(i) === 0) i++;
  while (i < n) {
    const c = src[i]!;
    const b = breakLen(i);
    if (b > 0) {
      line++;
      i += b;
      continue;
    }
    if (SPACE.test(c)) {
      i++;
      continue;
    }
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < n && breakLen(i) === 0) i++;
      continue;
    }
    if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      countLines(i, stop);
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && breakLen(j) === 0) j += src[j] === "\\" ? 1 + Math.max(1, breakLen(j + 1)) : 1;
      const startLine = line;
      const closed = src[j] === c;
      countLines(i, Math.min(j, n));
      out.push(closed ? { kind: "str", value: unescape(src.slice(i + 1, j)), line: startLine } : { kind: "bad", value: "", line: startLine });
      i = closed ? j + 1 : j;
      continue;
    }
    if (c === "`") {
      template(i + 1, line, false);
      continue;
    }
    if (c === "{") {
      braces.push(false);
      out.push({ kind: "punc", value: "{", line });
      i++;
      continue;
    }
    if (c === "}") {
      if (braces.pop() === true) {
        template(i + 1, line, true);
        continue;
      }
      out.push({ kind: "punc", value: "}", line });
      i++;
      continue;
    }
    if (c === "/") {
      const end = regexAllowed() ? regexEnd(i) : -1;
      if (end !== -1) {
        out.push({ kind: "re", value: src.slice(i, end), line });
        i = end;
      } else {
        out.push({ kind: "punc", value: "/", line });
        i++;
      }
      continue;
    }
    if (DIGIT.test(c) || (c === "." && next !== undefined && DIGIT.test(next))) {
      let j = i + 1;
      while (j < n && NUMBER_PART.test(src[j]!)) j++;
      out.push({ kind: "num", value: src.slice(i, j), line });
      i = j;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < n && ID_PART.test(src[j]!)) j++;
      out.push({ kind: "id", value: src.slice(i, j), line });
      i = j;
      continue;
    }
    out.push({ kind: "punc", value: c, line });
    i++;
  }
  return out;
}
