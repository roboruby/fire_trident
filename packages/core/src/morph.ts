import type { Path, Rule, Violation } from "./types.ts";
import { oneLine, truncate } from "./text.ts";

// ---------------------------------------------------------------------------
// Globs
// ---------------------------------------------------------------------------

/** Brace expansions allowed per glob. Past this a glob matches nothing, which guards against expansion bombs. */
const MAX_EXPANSIONS = 256;
const GLOB_CACHE_LIMIT = 512;
const globCache = new Map<string, string[][] | null>();

/**
 * Minimal glob matcher supporting **, *, ?, and {a,b}.
 * `*` and `?` stay inside one path segment (never cross "/"). `**` as a whole segment matches zero
 * or more directories, so "src/**" also matches "src". `{a,b,c}` alternatives may nest and may hold
 * "/" or wildcards; a brace group without a comma is literal. Everything else is literal (no
 * character classes, dotfiles are not special). A leading "./" or "/" on the glob is ignored.
 */
export function globMatch(glob: string, path: Path): boolean {
  const patterns = compileGlob(glob);
  if (patterns === null) return false;
  const target = path.split("/");
  return patterns.some((segments) => matchSegments(segments, target));
}

/** Brace-expanded, root-stripped, segment-split alternatives for a glob (null when it expands too far). Memoized. */
function compileGlob(glob: string): string[][] | null {
  const hit = globCache.get(glob);
  if (hit !== undefined) return hit;
  const expanded = expandBraces(glob);
  const compiled = expanded === null ? null : expanded.map((alt) => alt.replace(/^(?:\.\/|\/)+/, "").split("/"));
  if (globCache.size >= GLOB_CACHE_LIMIT) globCache.clear();
  globCache.set(glob, compiled);
  return compiled;
}

/** Shell-style brace expansion with nesting; unbalanced or comma-less braces stay literal. */
function expandBraces(glob: string): string[] | null {
  for (let open = glob.indexOf("{"); open !== -1; open = glob.indexOf("{", open + 1)) {
    let depth = 0;
    let close = -1;
    const commas: number[] = [];
    for (let i = open; i < glob.length && close === -1; i++) {
      const c = glob[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) close = i;
      else if (c === "," && depth === 1) commas.push(i);
    }
    if (close === -1 || commas.length === 0) continue;
    const tails = expandBraces(glob.slice(close + 1));
    if (tails === null) return null;
    const head = glob.slice(0, open);
    const cuts = [open, ...commas, close];
    const out: string[] = [];
    for (let k = 0; k + 1 < cuts.length; k++) {
      const options = expandBraces(glob.slice(cuts[k]! + 1, cuts[k + 1]!));
      if (options === null) return null;
      for (const option of options) {
        for (const tail of tails) {
          if (out.push(head + option + tail) > MAX_EXPANSIONS) return null;
        }
      }
    }
    return out;
  }
  return [glob];
}

/** Match path segments against glob segments; a "**" segment absorbs zero or more path segments. */
function matchSegments(glob: string[], path: string[]): boolean {
  const memo = new Map<number, boolean>();
  const width = path.length + 1;
  const go = (gi: number, pi: number): boolean => {
    const key = gi * width + pi;
    const known = memo.get(key);
    if (known !== undefined) return known;
    let result: boolean;
    const g = glob[gi];
    if (g === undefined) result = pi === path.length;
    else if (g === "**") result = go(gi + 1, pi) || (pi < path.length && go(gi, pi + 1));
    else result = pi < path.length && matchSegment(g, path[pi]!) && go(gi + 1, pi + 1);
    memo.set(key, result);
    return result;
  };
  return go(0, 0);
}

/** Wildcard match inside one segment (`*` any run, `?` one character), linear backtracking to the last `*`. */
function matchSegment(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    const c = pattern[p];
    if (c === "*") {
      star = p++;
      resume = t;
    } else if (c !== undefined && (c === "?" || c === text[t])) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** Files whose imports `importsOf` can read: the JS/TS family (.js .jsx .ts .tsx .mjs .cjs .mts .cts). */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/i;
const ALL_FILES = ["**/*"];

/**
 * Longest rule pattern (spec.pattern or spec.module) a rule may have, in characters. checkFile validates every rule it
 * scans, rules stored before the cap included, so the cap sits well above the longest kept rule: the Node built-ins
 * rule of the OpenSpec colonies is 258 characters.
 */
export const MAX_RULE_PATTERN = 1_024;
/**
 * Characters of one line (or one import specifier) a rule's pattern is tested on. Agents write the text rules scan and a
 * line has no length limit, so a longer line is tested on its first MAX_RULE_LINE characters: that bounds what any
 * accepted pattern costs per line.
 */
export const MAX_RULE_LINE = 1_000;

/** The part of a line or specifier a rule's pattern is tested on: at most its first MAX_RULE_LINE characters. */
export function ruleLine(text: string): string {
  return text.length > MAX_RULE_LINE ? text.slice(0, MAX_RULE_LINE) : text;
}

/** A quantifier at `i` of a pattern (`*`, `+`, `?`, `{n}`, `{n,}`, `{n,m}`): its bounds and its last character, or null. */
function quantifierAt(source: string, i: number): { min: number; max: number; end: number } | null {
  const c = source[i];
  if (c === "*") return { min: 0, max: Infinity, end: i };
  if (c === "+") return { min: 1, max: Infinity, end: i };
  if (c === "?") return { min: 0, max: 1, end: i };
  if (c !== "{") return null;
  const m = /^\{(\d+)(,(\d*))?\}/.exec(source.slice(i, i + 24));
  if (!m) return null; // a brace that is not a quantifier is a literal
  const min = Number(m[1]);
  const max = m[2] === undefined ? min : m[3] === "" ? Infinity : Number(m[3]);
  return { min, max, end: i + m[0].length - 1 };
}

/**
 * The first part of a pattern whose matching can take exponential time: a group repeated more than once that holds a
 * quantifier of its own (`(a+)+`, `(\w*\s?)*`, `(?:x+y){2,}`, `((ab)*c)+`), or null when there is none. A static check
 * on the pattern's text (escapes and character classes read as single atoms): it also refuses a few safe patterns, such
 * as `(\d+\.){3}`, which can be written out instead.
 */
export function nestedQuantifier(source: string): string | null {
  // The open groups, and whether a quantifier that lets the match vary in length sits inside each.
  const open: Array<{ at: number; varies: boolean }> = [];
  // What a quantifier here would repeat: the group just closed, or a single atom (null after "(" and "|").
  let atom: { at: number; varies: boolean } | null = null;
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (c === "\\") {
      atom = { at: i, varies: false };
      i++;
    } else if (c === "[") {
      const at = i;
      for (i++; i < source.length && source[i] !== "]"; i++) if (source[i] === "\\") i++;
      atom = { at, varies: false };
    } else if (c === "(") {
      open.push({ at: i, varies: false });
      // A group's prefix ((?:, (?=, (?!, (?<=, (?<!, (?<name>) is not a quantifier: skip to its last character.
      if (source[i + 1] === "?") for (i += 2; i < source.length && !":=!>".includes(source[i]!); i++);
      atom = null;
    } else if (c === ")") {
      const g = open.pop();
      if (g?.varies && open.length > 0) open[open.length - 1]!.varies = true;
      atom = g ?? null;
    } else if (c === "|") {
      atom = null;
    } else {
      const q = quantifierAt(source, i);
      if (q === null) {
        atom = { at: i, varies: false };
        continue;
      }
      i = source[q.end + 1] === "?" ? q.end + 1 : q.end;
      if (atom?.varies && q.max > 1) return source.slice(atom.at, i + 1);
      if (q.max > q.min && open.length > 0) open[open.length - 1]!.varies = true;
      atom = null;
    }
  }
  return null;
}

/**
 * Does this rule apply to this path at all (include/exclude/from globs)?
 * forbid-pattern scopes with spec.include, forbid-import with spec.from (both default to every file,
 * also when empty); spec.exclude removes paths. A single glob string is accepted for any list.
 */
export function ruleApplies(rule: Rule, path: Path): boolean {
  const spec = rule.spec ?? {};
  let scope: unknown;
  if (rule.kind === "forbid-pattern") scope = spec.include;
  else if (rule.kind === "forbid-import") scope = spec.from;
  else return false;
  const include = globList(scope, ALL_FILES);
  const exclude = globList(spec.exclude, []);
  return include.some((g) => globMatch(g, path)) && !exclude.some((g) => globMatch(g, path));
}

/**
 * Problems that make a rule unusable: unknown kind, a missing or invalid RegExp (spec.pattern or
 * spec.module, with optional spec.flags), a pattern longer than MAX_RULE_PATTERN or one that repeats
 * a group holding a quantifier (see nestedQuantifier), or a non-string glob, hint, or replacement.
 * Empty when valid.
 */
export function validateRule(rule: Pick<Rule, "kind" | "spec">): string[] {
  const spec = rule.spec ?? {};
  const field = rule.kind === "forbid-pattern" ? "pattern" : rule.kind === "forbid-import" ? "module" : null;
  if (field === null) return [`unknown rule kind: ${String(rule.kind)}`];
  const scopeField = field === "pattern" ? "include" : "from";
  const problems: string[] = [];
  const source = spec[field];
  const flags = spec.flags;
  if (typeof source !== "string" || source === "") {
    problems.push(`spec.${field} must be a non-empty string`);
  } else if (flags !== undefined && typeof flags !== "string") {
    problems.push("spec.flags must be a string");
  } else {
    try {
      new RegExp(source, lineFlags(flags));
      // Agents write the text a rule scans: a pattern that can backtrack without bound would let one line stall the colony.
      const nested = nestedQuantifier(source);
      if (source.length > MAX_RULE_PATTERN) problems.push(`spec.${field} is ${source.length} characters long; at most ${MAX_RULE_PATTERN} are allowed`);
      else if (nested !== null) problems.push(`spec.${field} repeats a group that holds a quantifier of its own (${nested}), which can take exponential time on a long line; write it without the nested repetition`);
    } catch (error) {
      problems.push(`spec.${field} is not a valid RegExp: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const key of [scopeField, "exclude"]) {
    const value = spec[key];
    if (value !== undefined && typeof value !== "string" && !(Array.isArray(value) && value.every((g) => typeof g === "string"))) {
      problems.push(`spec.${key} must be a glob or a list of globs`);
    }
  }
  if (spec.hint !== undefined && typeof spec.hint !== "string") problems.push("spec.hint must be a string");
  if (field === "pattern" && spec.replacement !== undefined && typeof spec.replacement !== "string") {
    problems.push("spec.replacement must be a string");
  }
  return problems;
}

/**
 * Evaluate one rule against one file's content. Returns [] when the rule does not apply to the path.
 * forbid-pattern: RegExp(spec.pattern, spec.flags) tested per line, one violation per matching line
 * ("g"/"y" flags are dropped so lines are tested independently). forbid-import: one violation per
 * import whose specifier matches RegExp(spec.module); only JS/TS-family files are scanned. Excerpt is
 * the trimmed line (at most 160 characters); message joins rule.description and spec.hint. A line
 * or specifier longer than MAX_RULE_LINE is tested on its first MAX_RULE_LINE characters (ruleLine).
 * Throws if the rule is invalid (see validateRule).
 */
export function checkFile(rule: Rule, path: Path, content: string): Violation[] {
  if (!ruleApplies(rule, path)) return [];
  if (rule.kind === "forbid-import" && !SCRIPT_FILE.test(path)) return [];
  const problems = validateRule(rule);
  if (problems.length > 0) throw new Error(`rule ${rule.id}: ${problems.join("; ")}`);
  const spec = rule.spec;
  const re = new RegExp(String(rule.kind === "forbid-pattern" ? spec.pattern : spec.module), lineFlags(spec.flags));
  const lines = content.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const message = ruleMessage(rule);
  const violation = (line: number): Violation => ({
    ruleId: rule.id,
    path,
    line,
    excerpt: truncate((lines[line - 1] ?? "").trim(), 160),
    message,
  });
  if (rule.kind === "forbid-pattern") {
    const out: Violation[] = [];
    lines.forEach((text, i) => {
      if (re.test(ruleLine(text))) out.push(violation(i + 1));
    });
    return out;
  }
  return importsOf(content)
    .filter((imp) => re.test(ruleLine(imp.specifier)))
    .map((imp) => violation(imp.line));
}

/** Flags for per-line testing: stateful "g"/"y" are dropped so RegExp.test has no lastIndex carry-over. */
function lineFlags(flags: unknown): string {
  return typeof flags === "string" ? flags.replace(/[gy]/g, "") : "";
}

function globList(value: unknown, fallback: string[]): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  const globs = list.filter((g): g is string => typeof g === "string" && g !== "");
  return globs.length > 0 ? globs : fallback;
}

function ruleMessage(rule: Rule): string {
  const description = oneLine(typeof rule.description === "string" ? rule.description : "");
  const hint = typeof rule.spec?.hint === "string" ? oneLine(rule.spec.hint) : "";
  if (hint === "") return description || `Violates rule ${rule.id}`;
  if (description === "") return hint;
  return `${/[.!?]$/.test(description) ? description : `${description}.`} ${hint}`;
}

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

/**
 * Extract static import/require/export-from specifiers with their 1-based line numbers (TS/JS).
 *
 * Covers `import x from "m"`, `import "m"`, `export * from "m"`, `export { a } from "m"`,
 * `require("m")`, `import("m")` (and type-only forms). A multi-line import reports the line of
 * its specifier. Comments, string and template contents, and regex literals are skipped by a
 * small lexer, so text that merely looks like an import is never reported.
 */
export function importsOf(source: string): Array<{ specifier: string; line: number }> {
  const t = tokenize(source);
  const found: Array<{ specifier: string; line: number }> = [];
  const taken = new Set<number>();
  const take = (k: number): void => {
    const tok = t[k];
    if (tok?.kind !== "str" || taken.has(k)) return;
    taken.add(k);
    found.push({ specifier: tok.value, line: tok.line });
  };
  const punc = (k: number, value: string): boolean => t[k]?.kind === "punc" && t[k]?.value === value;
  const word = (k: number, value: string): boolean => t[k]?.kind === "id" && t[k]?.value === value;
  const str = (k: number): boolean => t[k]?.kind === "str";

  for (let k = 0; k < t.length; k++) {
    const tok = t[k]!;
    if (tok.kind !== "id" || punc(k - 1, ".")) continue;
    if (tok.value === "require") {
      if (punc(k + 1, "(") && str(k + 2) && punc(k + 3, ")")) take(k + 2);
    } else if (tok.value === "import") {
      if (punc(k + 1, "(")) {
        if (str(k + 2) && (punc(k + 3, ")") || punc(k + 3, ","))) take(k + 2);
      } else if (str(k + 1)) {
        take(k + 1);
      } else {
        const at = clauseSpecifier(t, k + 1);
        if (at !== -1) take(at);
      }
    } else if (tok.value === "export") {
      let j = k + 1;
      if (word(j, "type")) j++;
      if (punc(j, "*")) {
        j++;
        if (word(j, "as")) j += 2;
      } else if (punc(j, "{")) {
        j = closingBrace(t, j) + 1;
        if (j === 0) continue;
      } else {
        continue;
      }
      if (word(j, "from") && str(j + 1)) take(j + 1);
    }
  }
  return found;
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

/** Index of the specifier token ending an import clause starting at `start` (`... from "m"`), or -1. */
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
 * Tokenize JS/TS just enough to find imports: skips comments, keeps string values, treats template
 * text and regex literals as opaque, and tracks lines (\n, \r\n, \r). Malformed input never throws;
 * unterminated strings and regexes stop at the end of their line.
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
