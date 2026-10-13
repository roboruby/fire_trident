import type { CheckResult, Colony, FileVersion, Intent, Path, Proposal, Rule, Sha } from "@fire_trident/core";
import { checkFile, importsOf, residualPaths, ruleApplies, validateRule } from "@fire_trident/core";
import type { Env } from "../env.ts";
import { bindingFor } from "../artifacts/shards.ts";
import { dispose, withArtifactsRetry } from "../artifacts/git.ts";
import { DEFAULT_NOT_VERIFIED } from "./logic.ts";

/**
 * Innate checks: the deterministic floor of the Decide prong, run on every proposal before any
 * model looks at it.
 * - Rule re-check: the proposal's changed files (new blobs read from its workspace through the
 *   binding, base blobs from trunk) must leave no violation of the intent's rule in its footprint,
 *   and must not add violations of any other colony rule. The intent's own rule is always checked.
 * - Residual: paths written outside the intent's declared footprint (a review signal, not a
 *   failure on its own).
 * - New files: a JS/TS file the change creates must hold code. One that is empty, has only
 *   comments, or has nothing but placeholder bodies ("not implemented" throws, TODO bodies) is a
 *   stub, and the change goes back to its agent.
 * - Not verified: the agent must state what it did not verify.
 * The results go into the proposal's evidence; the file contents feed the reflex arc.
 */

/** One written file with its old and new text. */
export interface InnateFile {
  path: Path;
  beforeBlob: Sha | null;
  afterBlob: Sha | null;
  /** Old text (null: new file, binary, too large or unreadable). */
  before: string | null;
  /** New text (null: deleted, binary, too large or unreadable). */
  after: string | null;
  binary: boolean;
  /** The new blob could not be read from the workspace. */
  unreadable: boolean;
}

/** What the innate checks found. */
export interface InnateResult {
  /** Rule re-check, blobs and the not-verified statement all pass. */
  ok: boolean;
  failures: string[];
  checks: CheckResult[];
  files: InnateFile[];
  /** Written paths outside the intent's footprint. */
  residual: Path[];
}

/** Reads blob bytes from a repo (null when absent). Injected in tests. */
export type BlobReader = (where: { namespace: string; name: string }, blobs: Sha[]) => Promise<Map<Sha, Uint8Array | null>>;

/** Everything the innate checks need. */
export interface InnateContext {
  env: Env;
  colony: Colony;
  intent: Intent | null;
  rules: Rule[];
  /** Base blob ids of paths missing from the read set (TrunkDO.baseBlobs). */
  baseBlobs?: (baseSha: Sha, paths: Path[]) => Promise<FileVersion[]>;
  read?: BlobReader;
}

/** Largest file the rule re-check and the reflex read. */
const MAX_TEXT_BYTES = 512 * 1024;
/**
 * Rules re-checked per proposal; the intent's own rule always is, whatever its place. Each file
 * version is tokenized once for every import rule (see ruleViolations), so 200 rules cost less
 * than 25 did when each import rule tokenized the file again.
 */
export const MAX_RULES = 200;
/** JS/TS files: the family import rules read, and the one the new-file check reads. */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;

/** Text of `bytes`, or null for binary (a NUL in the first 8 KiB, or invalid UTF-8) and oversized content. */
export function textOf(bytes: Uint8Array | null): { text: string | null; binary: boolean } {
  if (bytes === null) return { text: null, binary: false };
  if (bytes.length > MAX_TEXT_BYTES || bytes.subarray(0, 8192).includes(0)) return { text: null, binary: true };
  try {
    return { text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), binary: false };
  } catch {
    return { text: null, binary: true };
  }
}

/** Read blobs through the Artifacts binding for the repo's namespace (14-20 ms each, run in parallel). */
export function bindingReader(env: Env): BlobReader {
  return async (where, blobs) => {
    const out = new Map<Sha, Uint8Array | null>();
    const binding = bindingFor(env, where.namespace);
    if (!binding || blobs.length === 0) {
      for (const b of blobs) out.set(b, null);
      return out;
    }
    const repo = await withArtifactsRetry(() => binding.get(where.name));
    try {
      await Promise.all(
        [...new Set(blobs)].map(async (b) => {
          try {
            const blob = await withArtifactsRetry(() => repo.readBlob(b));
            out.set(b, blob ? new Uint8Array(await blob.arrayBuffer()) : null);
          } catch {
            out.set(b, null);
          }
        }),
      );
    } finally {
      dispose(repo);
    }
    return out;
  };
}

/** Run the innate checks on a proposal (see the module comment). Never throws for repository problems. */
export async function runInnateChecks(p: Proposal, ctx: InnateContext): Promise<InnateResult> {
  const read = ctx.read ?? bindingReader(ctx.env);
  const failures: string[] = [];
  const checks: CheckResult[] = [];

  // 1. Blobs: new ones from the workspace, base ones from trunk.
  const t0 = Date.now();
  const readSet = new Map(p.readSet.map((f) => [f.path, f.blob]));
  const missing = p.writeSet.map((w) => w.path).filter((path) => !readSet.has(path));
  if (missing.length > 0 && ctx.baseBlobs) {
    try {
      for (const v of await ctx.baseBlobs(p.baseSha, missing)) readSet.set(v.path, v.blob ?? null);
    } catch {
      // unknown base: treated as new files
    }
  }
  const afterIds = p.writeSet.map((w) => w.blob).filter((b): b is Sha => typeof b === "string");
  const beforeIds = p.writeSet.map((w) => readSet.get(w.path) ?? null).filter((b): b is Sha => typeof b === "string");
  const [afterBytes, beforeBytes] = await Promise.all([
    read({ namespace: p.workspace.namespace, name: p.workspace.name }, afterIds).catch(() => new Map<Sha, Uint8Array | null>()),
    read({ namespace: ctx.colony.trunk.namespace, name: ctx.colony.trunk.name }, beforeIds).catch(() => new Map<Sha, Uint8Array | null>()),
  ]);
  const files: InnateFile[] = p.writeSet.map((w) => {
    const beforeBlob = readSet.get(w.path) ?? null;
    const a = w.blob ? textOf(afterBytes.get(w.blob) ?? null) : { text: null, binary: false };
    const b = beforeBlob ? textOf(beforeBytes.get(beforeBlob) ?? null) : { text: null, binary: false };
    const unreadable = w.blob !== null && !afterBytes.get(w.blob);
    return { path: w.path, beforeBlob, afterBlob: w.blob, before: b.text, after: a.text, binary: a.binary || b.binary, unreadable };
  });
  const unreadable = files.filter((f) => f.unreadable);
  if (unreadable.length > 0) {
    const what = unreadable.map((f) => `${f.path} (${f.afterBlob?.slice(0, 10)})`).join(", ");
    failures.push(`new blobs not readable from workspace ${p.workspace.name}: ${what}; push the commit first`);
  }
  checks.push({ name: "innate: blobs", ok: unreadable.length === 0, ms: Date.now() - t0, detail: `${files.length} file(s) read${unreadable.length > 0 ? `, ${unreadable.length} missing` : ""}` });

  // 2. Rule re-check: the intent's rule is satisfied in its footprint; no rule gains violations.
  //    The intent's own rule goes first, so the cap never skips it.
  const t1 = Date.now();
  const footprint = ctx.intent?.footprint ?? p.declared.footprint;
  const own = ctx.intent?.ruleId;
  const ownRule = own ? ctx.rules.find((r) => r.id === own) : undefined;
  const ordered = ownRule ? [ownRule, ...ctx.rules.filter((r) => r !== ownRule)] : ctx.rules;
  const importsFor = importCache();
  for (const rule of ordered.slice(0, MAX_RULES)) {
    const notes: string[] = [];
    let ok = true;
    for (const f of files) {
      if (f.after === null) continue;
      let after: number;
      let before: number;
      try {
        after = ruleViolations(rule, f.path, f.after, importsFor);
        before = f.before === null ? 0 : ruleViolations(rule, f.path, f.before, importsFor);
      } catch {
        continue; // an invalid rule never blocks a proposal
      }
      if (after === 0 && before === 0) continue;
      notes.push(`${f.path} ${before}→${after}`);
      const inFootprint = residualPaths(footprint, [{ path: f.path, blob: f.afterBlob }]).length === 0;
      if (rule.id === own && inFootprint && after > 0) {
        ok = false;
        failures.push(`${f.path} still has ${after} violation${after === 1 ? "" : "s"} of rule ${rule.id} (${rule.description})`);
      } else if (after > before) {
        ok = false;
        failures.push(`${f.path} adds ${after - before} violation${after - before === 1 ? "" : "s"} of rule ${rule.id} (${rule.description})`);
      }
    }
    if (rule.id === own || notes.length > 0) checks.push({ name: `innate: rule ${rule.id}`, ok, ms: Date.now() - t1, detail: notes.join("; ") || "no violations in the changed files" });
  }
  if (ordered.length > MAX_RULES) {
    // Never silent: the evidence says which rules this proposal was not re-checked against.
    const skipped = ordered.slice(MAX_RULES).map((r) => r.id);
    checks.push({
      name: "innate: rules",
      ok: true,
      ms: 0,
      detail: `re-checked ${MAX_RULES} of ${ordered.length} rules (the per-proposal cap); not re-checked: ${skipped.slice(0, 10).join(", ")}${skipped.length > 10 ? ` and ${skipped.length - 10} more` : ""}`,
    });
  }

  // 3. Residual against the intent's own footprint (declared before work started).
  const residual = residualPaths(footprint, p.writeSet);
  checks.push({
    name: "innate: footprint",
    ok: residual.length === 0,
    ms: 0,
    detail: residual.length === 0 ? "every write is inside the intent's footprint" : `outside the footprint (review signal): ${residual.slice(0, 10).join(", ")}${residual.length > 10 ? ` and ${residual.length - 10} more` : ""}`,
  });

  // 4. New files hold code: an empty file, comments only, or nothing but placeholder bodies is a stub.
  const created = files.filter((f) => f.beforeBlob === null && f.afterBlob !== null && f.after !== null && SCRIPT_FILE.test(f.path));
  if (created.length > 0) {
    const hollow = created.flatMap((f) => {
      const h = hollowFile(f.path, f.after ?? "");
      return h ? [{ path: f.path, h }] : [];
    });
    for (const x of hollow) failures.push(hollowText(x.path, x.h));
    checks.push({
      name: "innate: new files",
      ok: hollow.length === 0,
      ms: 0,
      detail: hollow.length === 0 ? `${created.length} new file${created.length === 1 ? "" : "s"} with code` : `stubs: ${hollow.map((x) => `${x.path} (${x.h.kind})`).join(", ")}`.slice(0, 1_000),
    });
  }

  // 5. The honest gap statement.
  const nv = (p.evidence.notVerified ?? "").trim();
  const stated = nv !== "" && nv !== DEFAULT_NOT_VERIFIED;
  if (!stated) failures.push('no "Not verified:" statement from the agent: say what you did not check');
  checks.push({ name: "innate: not-verified", ok: stated, ms: 0, detail: stated ? nv.slice(0, 200) : "missing (platform default used)" });

  return { ok: failures.length === 0, failures, checks, files, residual };
}

// ---------------------------------------------------------------------------
// Rule re-check
// ---------------------------------------------------------------------------

/** The import specifiers of a file's text. */
type ImportsOf = (text: string) => ReadonlyArray<{ specifier: string }>;

/** importsOf memoized for one proposal: each file version is tokenized once, however many import rules read it. */
function importCache(): ImportsOf {
  const memo = new Map<string, ReadonlyArray<{ specifier: string }>>();
  return (text) => {
    let hit = memo.get(text);
    if (!hit) {
      hit = importsOf(text);
      memo.set(text, hit);
    }
    return hit;
  };
}

/**
 * Violations of one rule in one file version, counted as core's checkFile counts them (a parity
 * test keeps the two together). Import rules read the file's imports through `importsFor`, so one
 * tokenization serves them all: tokenizing again for every rule cost 0.7 s per proposal for a
 * 100 KB file at 200 rules. Throws for an invalid rule, as checkFile does.
 */
export function ruleViolations(rule: Rule, path: Path, text: string, importsFor: ImportsOf = importsOf): number {
  if (rule.kind !== "forbid-import") return checkFile(rule, path, text).length;
  if (!ruleApplies(rule, path) || !SCRIPT_FILE.test(path)) return 0;
  const problems = validateRule(rule);
  if (problems.length > 0) throw new Error(`rule ${rule.id}: ${problems.join("; ")}`);
  const flags = typeof rule.spec.flags === "string" ? rule.spec.flags.replace(/[gy]/g, "") : "";
  const re = new RegExp(String(rule.spec.module), flags);
  let n = 0;
  for (const imp of importsFor(text)) if (re.test(imp.specifier)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// New files that are stubs
// ---------------------------------------------------------------------------

/** Why a new file holds no implementation (see hollowFile). */
export interface Hollow {
  kind: "empty" | "comments" | "placeholders";
  /** The functions, methods or variables whose bodies are placeholders ("placeholders" only). */
  names: string[];
}

/**
 * Comments that mark unfinished work: a TODO or FIXME note ("TODO", "TODO: ...", "TODO(name) ...",
 * "TODO implement ..."), or one that says "not implemented" or "implement me".
 */
const TODO_START = /^(?:\/\/+|\/\*+)[\s*]*(?:TODO|FIXME)(?:\s*(?:$|\*\/|[:(\-–])|\s+implement)/;
const TODO_ANY = /\bnot\s+(?:yet\s+)?implemented\b|\bimplement\s+(?:me|this|it)\b/i;
/** An error message that only says the body is missing. */
const PLACEHOLDER_MESSAGE = /^(?:(?:method|function)\s+)?(?:not\s+(?:yet\s+)?implemented(?:\s+yet)?|unimplemented|todo(?:\s*[:-]?\s*implement(?:\s+(?:me|this|it))?)?|implement\s+(?:me|this|it))\s*[.!]?$/i;
/** Error classes whose name says the body is missing, whatever the message. */
const MISSING_ERRORS: ReadonlySet<string> = new Set(["NotImplementedError", "UnimplementedError"]);
/** Error classes a placeholder throws with a placeholder message. */
const PLAIN_ERRORS: ReadonlySet<string> = new Set(["Error", "TypeError"]);
/** Class member modifiers accepted before a method's name. */
const MEMBER_MODIFIERS: ReadonlySet<string> = new Set(["public", "private", "protected", "static", "override", "async"]);
/** Constructor parameter modifiers: they declare fields, which is code. */
const PARAMETER_PROPERTIES: ReadonlySet<string> = new Set(["public", "private", "protected", "readonly"]);
/** Punctuation read as one token. */
const MULTI_PUNC = ["...", "===", "!==", "=>", "??", "?.", "==", "!=", "<=", ">=", "&&", "||", "++", "--", "**"];

/**
 * Does a new file hold no implementation? Only JS/TS files are judged, and only three shapes count:
 * empty, comments only, or code that is nothing but placeholder bodies (one "not implemented"
 * throw, or an empty body marked TODO) with imports around them. Anything else counts as code, so
 * an index that re-exports, a type-only file, a no-op function and every other kind of file pass.
 */
export function hollowFile(path: Path, text: string): Hollow | null {
  if (!SCRIPT_FILE.test(path)) return null;
  if (text.trim() === "") return { kind: "empty", names: [] };
  // Without any placeholder marker only "comments only" is possible: the scan stops at the first token.
  const quick = !/throw|TODO|FIXME|implement/i.test(text);
  const scan = scanScript(text, quick);
  if (!scan || scan.directive) return null;
  if (scan.toks.length === 0) return { kind: "comments", names: [] };
  if (quick) return null;
  const names = placeholderBodies(scan.toks, scan.comments);
  return names ? { kind: "placeholders", names } : null;
}

/** What the agent reads when a file it created is a stub. */
function hollowText(path: Path, h: Hollow): string {
  if (h.kind === "empty") return `${path} is a new file and it is empty: write its content, or leave it out of the change`;
  if (h.kind === "comments") return `${path} is a new file with only comments in it: write its code, or leave it out of the change`;
  const names = `${h.names.slice(0, 3).join(", ")}${h.names.length > 3 ? ` and ${h.names.length - 3} more` : ""}`;
  return `${path} is a new file whose only code is placeholder bodies (${names}: a "not implemented" throw or a TODO): implement them, or leave the file out of the change`;
}

/** One token of the stub scan: identifier, string (its value), number or punctuation, at an offset. */
interface Tok {
  k: "id" | "str" | "num" | "p";
  v: string;
  at: number;
}

/** A comment and its offset. */
interface Comment {
  at: number;
  text: string;
}

/**
 * Tokens and comments of a JS/TS source, read only to tell stubs from code. Null when the scan cannot
 * be sure what it read (a template with substitutions, an unterminated string or comment), and then
 * the file counts as code. `directive` is set by a triple-slash directive, which is code too. With
 * `firstToken` the scan stops at the first token (enough to tell code from comments).
 */
function scanScript(src: string, firstToken = false): { toks: Tok[]; comments: Comment[]; directive: boolean } | null {
  const toks: Tok[] = [];
  const comments: Comment[] = [];
  let directive = false;
  const n = src.length;
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  if (src.startsWith("#!", i)) while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
  while (i < n && !(firstToken && toks.length > 0)) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
    } else if (c === "/" && src[i + 1] === "/") {
      let j = i + 2;
      while (j < n && src[j] !== "\n" && src[j] !== "\r") j++;
      const text = src.slice(i, j);
      if (/^\/\/\/\s*</.test(text)) directive = true;
      comments.push({ at: i, text });
      i = j;
    } else if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return null;
      comments.push({ at: i, text: src.slice(i, end + 2) });
      i = end + 2;
    } else if (c === '"' || c === "'" || c === "`") {
      let value = "";
      let j = i + 1;
      for (; j < n && src[j] !== c; j++) {
        const d = src[j]!;
        if (d === "\\") {
          value += src[j + 1] ?? "";
          j++;
        } else if ((c !== "`" && (d === "\n" || d === "\r")) || (c === "`" && d === "$" && src[j + 1] === "{")) {
          return null;
        } else {
          value += d;
        }
      }
      if (j >= n) return null;
      toks.push({ k: "str", v: value, at: i });
      i = j + 1;
    } else if (/[A-Za-z_$]/.test(c) || c.charCodeAt(0) > 127) {
      let j = i + 1;
      while (j < n && (/[\w$]/.test(src[j]!) || src.charCodeAt(j) > 127)) j++;
      toks.push({ k: "id", v: src.slice(i, j), at: i });
      i = j;
    } else if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[\w.]/.test(src[j]!)) j++;
      toks.push({ k: "num", v: src.slice(i, j), at: i });
      i = j;
    } else {
      const v = MULTI_PUNC.find((m) => src.startsWith(m, i)) ?? c;
      toks.push({ k: "p", v, at: i });
      i += v.length;
    }
  }
  return { toks, comments, directive };
}

/** A function or method body: whose it is, and whether it is a placeholder (else it is empty). */
interface Body {
  name: string;
  placeholder: boolean;
}

/**
 * The names of a file's placeholder bodies when its code is nothing else, or null. Accepted at the
 * top level: imports, and function, class and arrow-function declarations (exported or not) whose
 * every body is either a placeholder or empty, with at least one placeholder. A placeholder body is
 * a single "not implemented" throw, or an empty body with a TODO comment in it or right before its
 * declaration. Any other statement, class member or expression is code.
 */
function placeholderBodies(toks: Tok[], comments: Comment[]): string[] | null {
  const isP = (k: number, v: string): boolean => toks[k]?.k === "p" && toks[k]!.v === v;
  const isId = (k: number, v?: string): boolean => toks[k]?.k === "id" && (v === undefined || toks[k]!.v === v);
  // Index after the group opened at `k` (nested open/close pairs), or -1.
  const group = (k: number, open: string, close: string): number => {
    let depth = 0;
    for (let j = k; j < toks.length; j++) {
      if (isP(j, open)) depth++;
      else if (isP(j, close) && --depth === 0) return j + 1;
    }
    return -1;
  };
  // Index of the `stop` token ending a type annotation that starts at `k`, or -1 (an object type, or anything unexpected).
  const typeEnd = (k: number, stop: string): number => {
    let j = k;
    let expect = true;
    while (j >= 0 && j < toks.length) {
      const t = toks[j]!;
      if (t.k !== "p") {
        j++;
        expect = false;
      } else if (t.v === stop && !expect) {
        return j;
      } else if (t.v === "<" || t.v === "(" || t.v === "[") {
        j = group(j, t.v, t.v === "<" ? ">" : t.v === "(" ? ")" : "]");
        expect = false;
      } else if (t.v === "|" || t.v === "&" || t.v === "." || t.v === "=>") {
        j++;
        expect = true;
      } else {
        return -1;
      }
    }
    return -1;
  };
  // A placeholder throw at `k` (`throw new Error("not implemented")` and the like): the index after it, or -1.
  const placeholderThrow = (k: number): number => {
    if (!isId(k, "throw")) return -1;
    let j = k + 1;
    if (toks[j]?.k === "str") {
      if (!PLACEHOLDER_MESSAGE.test(toks[j]!.v.trim())) return -1;
      j++;
    } else {
      if (isId(j, "new")) j++;
      const name = toks[j];
      if (name?.k !== "id" || !isP(j + 1, "(")) return -1;
      const end = group(j + 1, "(", ")");
      if (end < 0) return -1;
      const args = toks.slice(j + 2, end - 1);
      const missing = MISSING_ERRORS.has(name.v) || (PLAIN_ERRORS.has(name.v) && args.length === 1 && args[0]!.k === "str" && PLACEHOLDER_MESSAGE.test(args[0]!.v.trim()));
      if (!missing) return -1;
      j = end;
    }
    return isP(j, ";") ? j + 1 : j;
  };
  // A TODO comment from offset `from` (where the declaration's region starts) up to offset `to`
  // (comments are in source order: a binary search finds the first one).
  const todoBetween = (from: number, to: number): boolean => {
    let lo = 0;
    let hi = comments.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (comments[mid]!.at < from) lo = mid + 1;
      else hi = mid;
    }
    for (let j = lo; j < comments.length && comments[j]!.at < to; j++) if (TODO_START.test(comments[j]!.text) || TODO_ANY.test(comments[j]!.text)) return true;
    return false;
  };
  // The body opening at `k`: a placeholder, an empty body, or null for code.
  const body = (k: number, name: string, from: number): { end: number; bodies: Body[] } | null => {
    if (!isP(k, "{")) return null;
    const end = group(k, "{", "}");
    if (end < 0) return null;
    if (end === k + 2) return { end, bodies: [{ name, placeholder: todoBetween(from, toks[end - 1]!.at) }] };
    return placeholderThrow(k + 1) === end - 1 ? { end, bodies: [{ name, placeholder: true }] } : null;
  };
  // Generics, parameters, return type and body from `k`, after a function's or method's name.
  const signature = (k: number, name: string, from: number, ctor = false): { end: number; bodies: Body[] } | null => {
    let j = isP(k, "<") ? group(k, "<", ">") : k;
    if (j < 0 || !isP(j, "(")) return null;
    const params = group(j, "(", ")");
    if (params < 0) return null;
    if (ctor && toks.slice(j, params).some((t) => t.k === "id" && PARAMETER_PROPERTIES.has(t.v))) return null;
    j = isP(params, ":") ? typeEnd(params + 1, "{") : params;
    return j < 0 ? null : body(j, name, from);
  };
  // A function from its `function` keyword at `k`.
  const fn = (k: number, fallback: string, from: number): { end: number; bodies: Body[] } | null => {
    let j = isP(k + 1, "*") ? k + 2 : k + 1;
    let name = fallback;
    if (isId(j)) name = toks[j++]!.v;
    return signature(j, name, from);
  };
  // A class from its `class` keyword at `k`: one body per method; null when it has anything but methods.
  const cls = (k: number, from: number): { end: number; bodies: Body[] } | null => {
    let j = k + 1;
    let name = "default";
    if (isId(j) && !isId(j, "extends") && !isId(j, "implements")) name = toks[j++]!.v;
    if (!isP(j, "{")) j = typeEnd(j, "{");
    if (j < 0) return null;
    const end = group(j, "{", "}");
    if (end < 0) return null;
    const bodies: Body[] = [];
    let region = toks[j]!.at;
    let m = j + 1;
    while (m < end - 1) {
      if (isP(m, ";")) {
        m++;
        continue;
      }
      while (isId(m) && MEMBER_MODIFIERS.has(toks[m]!.v) && !isP(m + 1, "(") && !isP(m + 1, "<")) m++;
      if ((isId(m, "get") || isId(m, "set")) && (isId(m + 1) || toks[m + 1]?.k === "str")) m++;
      if (isP(m, "*")) m++;
      const key = toks[m];
      if (!key || (key.k !== "id" && key.k !== "str")) return null;
      m = isP(m + 1, "?") ? m + 2 : m + 1;
      const r = signature(m, key.v, region, key.v === "constructor");
      if (!r) return null;
      bodies.push(...r.bodies);
      region = toks[r.end - 1]!.at + 1;
      m = r.end;
    }
    if (bodies.length === 0 && todoBetween(from, toks[end - 1]!.at)) bodies.push({ name, placeholder: true });
    return { end, bodies };
  };
  // `const name = (...) => { ... }` (or a function expression) from the keyword at `k`.
  const arrow = (k: number, from: number): { end: number; bodies: Body[] } | null => {
    let j = k + 1;
    if (!isId(j)) return null;
    const name = toks[j++]!.v;
    if (isP(j, ":")) j = typeEnd(j + 1, "=");
    if (j < 0 || !isP(j, "=")) return null;
    j++;
    if (isId(j, "async") && !isP(j + 1, "=>")) j++;
    let r: { end: number; bodies: Body[] } | null;
    if (isId(j, "function")) {
      r = fn(j, name, from);
    } else {
      if (isP(j, "<")) j = group(j, "<", ">");
      if (isP(j, "(")) j = group(j, "(", ")");
      else if (isId(j)) j++;
      else return null;
      if (j >= 0 && isP(j, ":")) j = typeEnd(j + 1, "=>");
      if (j < 0 || !isP(j, "=>")) return null;
      r = body(j + 1, name, from);
    }
    return r && isP(r.end, ";") ? { end: r.end + 1, bodies: r.bodies } : r;
  };

  const names: string[] = [];
  let from = 0;
  let i = 0;
  while (i < toks.length) {
    if (isP(i, ";")) {
      i++;
      continue;
    }
    let r: { end: number; bodies: Body[] } | null = null;
    if (isId(i, "import") && !isP(i + 1, "(") && !isP(i + 1, ".")) {
      // import x from "m"; import { a } from "m"; import "m"; import x = require("m");
      let j = i + 1;
      while (j < toks.length && toks[j]!.k !== "str") {
        if (!isId(j) && !["{", "}", ",", "*", "=", "("].some((v) => isP(j, v))) return null;
        j++;
      }
      if (j >= toks.length) return null;
      j++;
      if (isP(j, ")")) j++;
      r = { end: isP(j, ";") ? j + 1 : j, bodies: [] };
    } else {
      let j = i;
      if (isId(j, "export")) j++;
      if (isId(j, "default")) j++;
      if (isId(j, "async") && isId(j + 1, "function")) r = fn(j + 1, "default", from);
      else if (isId(j, "function")) r = fn(j, "default", from);
      else if (isId(j, "class")) r = cls(j, from);
      else if (isId(j, "const") || isId(j, "let") || isId(j, "var")) r = arrow(j, from);
      else if (j === i && isId(j, "throw")) {
        const end = placeholderThrow(j);
        r = end < 0 ? null : { end, bodies: [{ name: "top level", placeholder: true }] };
      }
    }
    if (!r) return null;
    for (const b of r.bodies) if (b.placeholder) names.push(b.name);
    from = toks[r.end - 1]!.at + 1;
    i = r.end;
  }
  return names.length > 0 ? names : null;
}
