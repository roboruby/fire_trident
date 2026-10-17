import type { Path, Recipe, RecipeKind, RecipeRefusal } from "./types.ts";
import { globMatch } from "./morph.ts";

/**
 * Recipes: the built-in transforms the trunk writer runs at landing (worker trunk/recipes.ts), and how a recipe is read.
 * Each transform is a pure function of one file's path and text: no I/O, no clock, no randomness, so running it twice
 * gives the same output, and the same recipe applied to the same text anywhere gives the same bytes.
 *
 * - `rename-identifier` { from, to }: renames one JavaScript or TypeScript identifier wherever it is an identifier token
 *   that names a binding: its declaration (an export included), every reference, type references, import and export
 *   specifiers, and a namespace import's member reads (`ns.from`) when the namespace is a module in the recipe's scope.
 *   It leaves strings, template literal text, comments, regular expressions, property reads (`a.from`, `a?.from`),
 *   private names (`#from`), object keys and methods (`{ from: 1 }`, `{ from() {} }`), class members, interface and
 *   type literal members, and enum members. A shorthand property (`{ from }`, also in a destructuring pattern) keeps its
 *   key: `{ from: to }`. An import from a module outside the scope (a package, or a relative path the scope does not
 *   cover) keeps the imported name and renames the local one (`import { from as to }`); a re-export from one keeps it
 *   too (`export { from as to }`). It reads `.js`, `.ts`, `.mjs`, `.cjs`, `.mts` and `.cts` files; JSX files are out of
 *   its language. It does not rename names read through `require()`, a dynamic `import()`, a TypeScript namespace
 *   (`N.from`) or a path alias, and it renames every binding of that name in a file, shadowed ones included, which keeps
 *   the file's meaning since all of them move together. A file that already uses the new name as an identifier is left
 *   as it was (`name-taken`).
 * - `replace-import` { from, to, prefix? }: rewrites a module specifier string where it names a module: `from "…"`,
 *   `import "…"`, `import("…")` and `require("…")`. Exact by default; with `prefix`, every specifier that starts with
 *   `from` gets that start replaced. The quotes stay as they were.
 * - `text-replace` { find, replace } or { pattern, replace, flags? }: for config files. An exact string, every
 *   occurrence; or a regular expression anchored to whole lines (it starts with `^` and ends with `$`), applied line by
 *   line, `$1` and the like naming its groups. Any UTF-8 text file.
 */

/** The version of each built-in kind's transform. A recipe pinned to another version is refused, never run. */
export const RECIPE_VERSIONS: Readonly<Record<Exclude<RecipeKind, "module">, string>> = {
  "rename-identifier": "1",
  "replace-import": "1",
  "text-replace": "1",
};
/** The version of the `module` kind's runner (the sandboxed transform a person supplies, FT_RECIPE_MODULES). */
export const RECIPE_MODULE_VERSION = "1";

/** Globs a scope holds at most, and characters per glob, per argument and per pattern; a module's source at most. */
export const RECIPE_SCOPE_GLOBS = 20;
const GLOB_CHARS = 200;
const ARG_CHARS = 400;
const PATTERN_CHARS = 200;
export const RECIPE_MODULE_CHARS = 64 * 1024;
/** Lines longer than this are never tested against a text-replace pattern. */
const PATTERN_LINE_CHARS = 4_000;

/** One file through a recipe: its new text (the same text when nothing changed), or why it was left as it was. */
export type RecipeOutput = { ok: true; text: string } | { ok: false; reason: RecipeRefusal; detail: string };

/** A recipe as declared, or why it is refused (a sentence that says what to change). */
export type RecipeParse = { ok: true; recipe: Recipe } | { ok: false; error: string };

const KINDS: ReadonlySet<string> = new Set<RecipeKind>(["rename-identifier", "replace-import", "text-replace", "module"]);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
/** Words that can never be renamed to or from: reserved words, and the few that change meaning in some positions. */
const RESERVED: ReadonlySet<string> = new Set(
  (
    "break case catch class const continue debugger default delete do else enum export extends false finally for function if import in " +
    "instanceof new null return super switch this throw true try typeof var void while with yield let static implements interface package " +
    "private protected public await async arguments eval undefined"
  ).split(" "),
);
/** Nested quantifiers (`(a+)+`), which can take a regular expression engine exponential time. */
const NESTED_QUANTIFIER = /\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/;

/**
 * Read a recipe from a request: its kind, its version (absent: the kind's current version, which the recipe is then pinned
 * to), its arguments and its scope. `modules`: whether the `module` kind is on (FT_RECIPE_MODULES). Pure.
 */
export function parseRecipe(input: unknown, opts: { modules?: boolean } = {}): RecipeParse {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return { ok: false, error: "a recipe is an object with kind, args and scope" };
  const raw = input as Record<string, unknown>;
  const kind = typeof raw.kind === "string" ? raw.kind : "";
  if (!KINDS.has(kind)) return { ok: false, error: `unknown recipe kind ${JSON.stringify(kind)}: use rename-identifier, replace-import or text-replace` };
  if (kind === "module" && opts.modules !== true) {
    return { ok: false, error: "module recipes are off on this deployment (FT_RECIPE_MODULES): use rename-identifier, replace-import or text-replace" };
  }
  const current = kind === "module" ? RECIPE_MODULE_VERSION : RECIPE_VERSIONS[kind as Exclude<RecipeKind, "module">];
  const version = raw.version === undefined || raw.version === null || raw.version === "" ? current : String(raw.version);
  if (version !== current) {
    return { ok: false, error: `${kind} is at version ${current} here, and a recipe pinned to version ${version} is refused, never run: declare it again with version ${current}` };
  }
  const scope = parseScope(raw.scope);
  if (typeof scope === "string") return { ok: false, error: scope };
  const args = raw.args === undefined ? {} : raw.args;
  if (args === null || typeof args !== "object" || Array.isArray(args)) return { ok: false, error: "args must be an object" };
  const parsed = parseArgs(kind as RecipeKind, args as Record<string, unknown>);
  if (typeof parsed === "string") return { ok: false, error: parsed };
  return { ok: true, recipe: { kind: kind as RecipeKind, version, args: parsed, scope } };
}

function parseScope(raw: unknown): string[] | string {
  const list = typeof raw === "string" ? [raw] : raw;
  if (!Array.isArray(list) || list.length === 0) return "scope must name at least one glob of paths, such as src/**";
  if (list.length > RECIPE_SCOPE_GLOBS) return `scope names at most ${RECIPE_SCOPE_GLOBS} globs`;
  const out: string[] = [];
  for (const g of list) {
    if (typeof g !== "string") return "every scope entry must be a glob string";
    let glob = g.trim();
    while (glob.startsWith("./")) glob = glob.slice(2);
    if (glob === "" || glob.length > GLOB_CHARS) return `a scope glob must be 1 to ${GLOB_CHARS} characters`;
    if (glob.startsWith("/") || glob.includes("\\") || /(^|\/)\.\.(\/|$)/.test(glob) || /[\u0000-\u001f]/.test(glob)) {
      return `scope glob ${JSON.stringify(glob)} must be a path inside the repository, without .. or backslashes`;
    }
    if (!out.includes(glob)) out.push(glob);
  }
  return out;
}

function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
}

function unknownKeys(args: Record<string, unknown>, allowed: readonly string[]): string | null {
  const extra = Object.keys(args).filter((k) => !allowed.includes(k));
  return extra.length > 0 ? `unknown argument${extra.length === 1 ? "" : "s"} ${extra.join(", ")}: this kind takes ${allowed.join(", ")}` : null;
}

function parseArgs(kind: RecipeKind, args: Record<string, unknown>): Record<string, string | boolean> | string {
  if (kind === "rename-identifier") {
    const extra = unknownKeys(args, ["from", "to"]);
    if (extra) return extra;
    const from = str(args, "from")?.trim() ?? "";
    const to = str(args, "to")?.trim() ?? "";
    for (const [name, v] of [["from", from], ["to", to]] as const) {
      if (!IDENT.test(v)) return `${name} must be a JavaScript identifier (letters, digits, _ and $, not starting with a digit), got ${JSON.stringify(v)}`;
      if (RESERVED.has(v)) return `${name} is a reserved word in JavaScript (${v}) and cannot be renamed`;
    }
    if (from === to) return "from and to are the same name";
    return { from, to };
  }
  if (kind === "replace-import") {
    const extra = unknownKeys(args, ["from", "to", "prefix"]);
    if (extra) return extra;
    const from = str(args, "from") ?? "";
    const to = str(args, "to") ?? "";
    for (const [name, v] of [["from", from], ["to", to]] as const) {
      if (v === "" || v.length > ARG_CHARS || /["'`\\\s]/.test(v)) return `${name} must be a module specifier of 1 to ${ARG_CHARS} characters, without quotes, backslashes or spaces`;
    }
    if (from === to) return "from and to are the same specifier";
    if (args.prefix !== undefined && typeof args.prefix !== "boolean") return "prefix must be true or false";
    return { from, to, ...(args.prefix === true ? { prefix: true } : {}) };
  }
  if (kind === "text-replace") {
    const extra = unknownKeys(args, ["find", "pattern", "replace", "flags"]);
    if (extra) return extra;
    const find = str(args, "find");
    const pattern = str(args, "pattern");
    const replace = str(args, "replace");
    if (replace === undefined || replace.length > ARG_CHARS) return `replace must be a string of at most ${ARG_CHARS} characters`;
    if ((find === undefined) === (pattern === undefined)) return "text-replace takes find (an exact string) or pattern (an anchored regular expression), one of them";
    if (find !== undefined) {
      if (find === "" || find.length > ARG_CHARS) return `find must be 1 to ${ARG_CHARS} characters`;
      if (find === replace) return "find and replace are the same text";
      if (args.flags !== undefined) return "flags go with pattern only";
      return { find, replace };
    }
    const flags = args.flags === undefined ? "" : str(args, "flags");
    if (flags !== "" && flags !== "i") return 'flags may only be "i" (ignore case)';
    const problem = patternProblem(pattern!);
    if (problem) return problem;
    return { pattern: pattern!, replace, ...(flags ? { flags } : {}) };
  }
  const extra = unknownKeys(args, ["source"]);
  if (extra) return extra;
  const source = str(args, "source") ?? "";
  if (source.trim() === "" || source.length > RECIPE_MODULE_CHARS) return `source must be a module of 1 to ${RECIPE_MODULE_CHARS} characters`;
  return { source };
}

/** Why a text-replace pattern is refused, or null: it must be anchored to whole lines, short, compile, and have no nested quantifier. */
function patternProblem(pattern: string): string | null {
  if (pattern.length === 0 || pattern.length > PATTERN_CHARS) return `pattern must be 1 to ${PATTERN_CHARS} characters`;
  if (!pattern.startsWith("^") || !pattern.endsWith("$") || pattern.endsWith("\\$")) return "pattern must be anchored to a whole line: start it with ^ and end it with $";
  if (NESTED_QUANTIFIER.test(pattern)) return "pattern has a quantified group that holds a quantifier, which can take exponential time: rewrite it without nesting";
  try {
    new RegExp(pattern, "u");
  } catch (e) {
    return `pattern is not a valid regular expression: ${e instanceof Error ? e.message : String(e)}`;
  }
  return null;
}

/** Whether a recipe covers `path` (one of its scope globs matches it). */
export function recipeCovers(recipe: Pick<Recipe, "scope">, path: Path): boolean {
  return recipe.scope.some((g) => globMatch(g, path));
}

/** The paths a scope names before its first wildcard, for an intent's footprint ("src/**" gives "src"); a glob with none, itself. */
export function scopeFootprint(scope: readonly string[]): Path[] {
  const out: Path[] = [];
  for (const glob of scope) {
    const fixed: string[] = [];
    for (const seg of glob.split("/")) {
      if (/[*?{]/.test(seg)) break;
      fixed.push(seg);
    }
    const path = fixed.length > 0 ? fixed.join("/") : glob;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/** A recipe in a few words, for reasons and commit messages: "rename-identifier compose to assemble". */
export function recipeText(recipe: Pick<Recipe, "kind" | "args">): string {
  const a = recipe.args;
  if (recipe.kind === "rename-identifier") return `rename-identifier ${String(a.from)} to ${String(a.to)}`;
  if (recipe.kind === "replace-import") return `replace-import ${String(a.from)} with ${String(a.to)}${a.prefix === true ? " (prefix)" : ""}`;
  if (recipe.kind === "text-replace") return typeof a.find === "string" ? "text-replace of an exact string" : "text-replace of an anchored pattern";
  return "module recipe";
}

/** The names a change imports once a recipe applied to its files: a rename maps its old name to the new one; other kinds keep them. */
export function recipeNames(recipe: Pick<Recipe, "kind" | "args">, names: readonly string[]): string[] {
  if (recipe.kind !== "rename-identifier") return [...names];
  return names.map((n) => (n === recipe.args.from ? String(recipe.args.to) : n));
}

/**
 * Run one built-in recipe over one file: the new text (equal to `text` when nothing changes), or why the file is left as
 * it was. `text` null means the file is binary. Pure and deterministic. The `module` kind is not run here (the trunk
 * writer's sandbox runs it): it answers out-of-language.
 */
export function applyRecipe(recipe: Recipe, path: Path, text: string | null): RecipeOutput {
  if (text === null) return { ok: false, reason: "binary", detail: "not UTF-8 text" };
  if (recipe.kind === "text-replace") return textReplace(text, recipe.args);
  if (recipe.kind === "module") return { ok: false, reason: "out-of-language", detail: "a module recipe runs only in the sandbox" };
  const lang = scriptLanguage(path);
  if (lang !== null) return { ok: false, reason: "out-of-language", detail: lang };
  const lexed = tokenize(text);
  if ("error" in lexed) return { ok: false, reason: "unparsable", detail: lexed.error };
  if (recipe.kind === "replace-import") return { ok: true, text: replaceImport(text, lexed, recipe.args) };
  return renameIdentifier(text, lexed, path, recipe);
}

/** Two runs of a recipe over the same files agree exactly (the determinism check: run twice, compare). */
export function sameOutputs(a: readonly RecipeOutput[], b: readonly RecipeOutput[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    if (x.ok !== y.ok) return false;
    if (x.ok && y.ok && x.text !== y.text) return false;
    if (!x.ok && !y.ok && (x.reason !== y.reason || x.detail !== y.detail)) return false;
  }
  return true;
}

/** Why a path is outside the script language, or null for a JavaScript or TypeScript file. */
function scriptLanguage(path: Path): string | null {
  if (/\.(?:jsx|tsx)$/i.test(path)) return "JSX files are outside this recipe's language in this version";
  if (!/\.(?:[cm]?[jt]s)$/i.test(path)) return "not a JavaScript or TypeScript file";
  return null;
}

// ---------------------------------------------------------------------------
// text-replace
// ---------------------------------------------------------------------------

function textReplace(text: string, args: Record<string, string | boolean>): RecipeOutput {
  const replace = String(args.replace ?? "");
  if (typeof args.find === "string") {
    if (args.find === "" || !text.includes(args.find)) return { ok: true, text };
    return { ok: true, text: text.split(args.find).join(replace) };
  }
  const pattern = typeof args.pattern === "string" ? args.pattern : "";
  if (patternProblem(pattern) !== null) return { ok: false, reason: "unparsable", detail: "the recipe's pattern is not one this version runs" };
  const re = new RegExp(pattern, args.flags === "i" ? "iu" : "u");
  const lines = text.split("\n");
  let changed = false;
  const out = lines.map((line) => {
    const cr = line.endsWith("\r");
    const body = cr ? line.slice(0, -1) : line;
    if (body.length > PATTERN_LINE_CHARS || !re.test(body)) return line;
    const next = body.replace(re, replace);
    if (next !== body) changed = true;
    return cr ? `${next}\r` : next;
  });
  return { ok: true, text: changed ? out.join("\n") : text };
}

// ---------------------------------------------------------------------------
// The script reader: a tokenizer for JavaScript and TypeScript that knows strings, templates, comments, regular
// expressions and what each brace opens. It is not a parser: it reads tokens and the bracket each one sits in.
// ---------------------------------------------------------------------------

type TokKind = "ident" | "private" | "num" | "str" | "tmpl" | "regex" | "punct";

/** What a bracket opens: a statement block, an object literal or pattern (or type literal), a class, interface or enum body, an import or export list, a parenthesis, an index, or a template expression. */
type GroupKind = "block" | "object" | "class" | "type" | "enum" | "specifiers" | "paren" | "bracket" | "template";

interface Tok {
  k: TokKind;
  v: string;
  s: number;
  e: number;
  /** A line break comes before it. */
  nl: boolean;
  /** The group it sits in (-1: top level). */
  g: number;
  /** A template piece that ends with `${`. */
  open?: boolean;
  /** A `}` or `)`: the group it closes. */
  closes?: number;
  /** A `:` that ends a `case` or `default` label. */
  caseColon?: boolean;
}

interface Group {
  kind: GroupKind;
  open: number;
  close: number;
}

interface Lexed {
  toks: Tok[];
  groups: Group[];
}

const ID_START = /[\p{ID_Start}$_]/u;
const ID_PART = /[\p{ID_Continue}$\u200c\u200d]/u;
const NUMBER = /^(?:0[xX][\da-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)n?/;
const PUNCTUATORS = [
  ">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=",
  "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>",
  "{", "}", "(", ")", "[", "]", ";", ",", "<", ">", "+", "-", "*", "/", "%", "&", "|", "^", "!", "~", "?", ":", "=", ".", "@", "#",
];
/** Words after which a `/` starts a regular expression. */
const REGEX_AFTER = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "throw", "case", "do", "else", "yield", "await"]);
/** Words before a `{` that opens an object (or pattern, or type literal) rather than a block. */
const OBJECT_AFTER = new Set(["return", "throw", "typeof", "case", "yield", "await", "in", "of", "new", "delete", "instanceof", "extends", "default", "as", "satisfies", "keyof"]);
const BLOCK_AFTER_PUNCT = new Set([")", "=>", ";", "}", "{", ">", ">>", ">>>", "]"]);
const MODIFIERS = new Set(["static", "public", "private", "protected", "readonly", "abstract", "override", "declare", "accessor", "async", "get", "set"]);

const isLineBreak = (c: string): boolean => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
const isSpace = (c: string): boolean => c === " " || c === "\t" || c === "\v" || c === "\f" || c === "\u00a0" || c === "\ufeff" || /\s/u.test(c);

/** The line of an offset, 1-based. */
function lineAt(src: string, at: number): number {
  let n = 1;
  for (let i = 0; i < at && i < src.length; i++) if (src[i] === "\n") n++;
  return n;
}

/** The next character after `i` that is not a space or line break (comments are not skipped). */
function peekChar(src: string, i: number): string {
  while (i < src.length && (isSpace(src[i]!) || isLineBreak(src[i]!))) i++;
  return src[i] ?? "";
}

/** Tokenize a script, or say why it cannot be read (with the line). */
function tokenize(src: string): Lexed | { error: string } {
  const toks: Tok[] = [];
  const groups: Group[] = [];
  const stack: number[] = [];
  let i = 0;
  let nl = false;
  let pending: { kind: GroupKind; depth: number } | null = null;
  let importing = false;
  let caseDepth = -1;
  const fail = (what: string, at: number): { error: string } => ({ error: `${what} at line ${lineAt(src, at)}` });
  const top = (): number => (stack.length > 0 ? stack[stack.length - 1]! : -1);
  const push = (t: Omit<Tok, "nl" | "g">): Tok => {
    const tok: Tok = { ...t, nl, g: top() };
    toks.push(tok);
    nl = false;
    return tok;
  };
  const prevTok = (): Tok | undefined => toks[toks.length - 1];
  const regexAllowed = (): boolean => {
    const p = prevTok();
    if (!p) return true;
    if (p.k === "num" || p.k === "str" || p.k === "regex" || p.k === "private") return false;
    if (p.k === "tmpl") return p.open === true;
    if (p.k === "ident") return REGEX_AFTER.has(p.v);
    if (p.v === ")" || p.v === "]" || p.v === "++" || p.v === "--") return false;
    if (p.v === "}") {
      const closed = p.closes !== undefined ? groups[p.closes] : undefined;
      return !closed || (closed.kind !== "object" && closed.kind !== "template");
    }
    return true;
  };
  const braceKind = (): GroupKind => {
    if (pending && pending.depth === stack.length) {
      const kind = pending.kind;
      pending = null;
      return kind;
    }
    const p = prevTok();
    if (!p) return "block";
    if (p.k === "punct") {
      if (BLOCK_AFTER_PUNCT.has(p.v)) return "block";
      if (p.v === ":") return p.caseColon ? "block" : "object";
      if (p.v === ",") return importing ? "specifiers" : "object";
      return "object";
    }
    if (p.k === "ident") {
      if (p.v === "const" || p.v === "let" || p.v === "var" || p.v === "using") return "object";
      if (p.v === "import" || p.v === "export") return "specifiers";
      if (p.v === "type") {
        const pp = toks[toks.length - 2];
        if (pp && pp.k === "ident" && (pp.v === "import" || pp.v === "export")) return "specifiers";
      }
      if (OBJECT_AFTER.has(p.v)) return "object";
      return "block";
    }
    if (p.k === "tmpl") return p.open ? "object" : "block";
    return "block";
  };
  // A template's text from `at` to its closing backtick or its next `${`.
  const templateText = (at: number): { end: number; open: boolean } | null => {
    let j = at;
    while (j < src.length) {
      const c = src[j]!;
      if (c === "\\") {
        j += 2;
        continue;
      }
      if (c === "`") return { end: j + 1, open: false };
      if (c === "$" && src[j + 1] === "{") return { end: j + 2, open: true };
      j++;
    }
    return null;
  };

  if (src.startsWith("#!")) {
    while (i < src.length && !isLineBreak(src[i]!)) i++;
  }
  while (i < src.length) {
    const c = src[i]!;
    if (isLineBreak(c)) {
      nl = true;
      i++;
      continue;
    }
    if (isSpace(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && !isLineBreak(src[i]!)) i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return fail("an unterminated comment", i);
      if (/[\n\r\u2028\u2029]/.test(src.slice(i, end))) nl = true;
      i = end + 2;
      continue;
    }
    const start = i;
    if (c === "`") {
      const t = templateText(i + 1);
      if (!t) return fail("an unterminated template literal", start);
      push({ k: "tmpl", v: src.slice(start, t.end), s: start, e: t.end, ...(t.open ? { open: true } : {}) });
      if (t.open) {
        groups.push({ kind: "template", open: toks.length - 1, close: -1 });
        stack.push(groups.length - 1);
      }
      i = t.end;
      continue;
    }
    if (c === "'" || c === '"') {
      let j = i + 1;
      for (;;) {
        if (j >= src.length) return fail("an unterminated string", start);
        const d = src[j]!;
        if (d === "\\") {
          j += src[j + 1] === "\r" && src[j + 2] === "\n" ? 3 : 2;
          continue;
        }
        if (d === c) break;
        if (d === "\n" || d === "\r") return fail("an unterminated string", start);
        j++;
      }
      push({ k: "str", v: src.slice(i, j + 1), s: start, e: j + 1 });
      importing = false;
      i = j + 1;
      continue;
    }
    if (c === "\\") return fail("an escaped identifier this reader does not read", i);
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j]!)) j++;
      if (src[j] === "\\") return fail("an escaped identifier this reader does not read", j);
      const word = src.slice(i, j);
      const prev = prevTok();
      const member = prev !== undefined && prev.k === "punct" && (prev.v === "." || prev.v === "?.");
      push({ k: "ident", v: word, s: start, e: j });
      if (!member) {
        const next = peekChar(src, j);
        if ((word === "class" || word === "interface" || word === "enum") && (next === "{" || ID_START.test(next))) {
          pending = { kind: word === "class" ? "class" : word === "interface" ? "type" : "enum", depth: stack.length };
        }
        if (word === "import" && next !== "(" && next !== ".") importing = true;
        if (word === "case" || (word === "default" && next === ":")) caseDepth = stack.length;
      }
      i = j;
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = NUMBER.exec(src.slice(i, i + 400));
      if (!m || m[0] === "") return fail("a number this reader does not read", i);
      let j = i + m[0].length;
      if (j < src.length && ID_START.test(src[j]!)) return fail("a number run into a name", i);
      push({ k: "num", v: m[0], s: start, e: j });
      i = j;
      continue;
    }
    if (c === "#" && ID_START.test(src[i + 1] ?? "")) {
      let j = i + 2;
      while (j < src.length && ID_PART.test(src[j]!)) j++;
      push({ k: "private", v: src.slice(i, j), s: start, e: j });
      i = j;
      continue;
    }
    if (c === "/" && regexAllowed()) {
      let j = i + 1;
      let inClass = false;
      for (;;) {
        if (j >= src.length || isLineBreak(src[j]!)) return fail("an unterminated regular expression", start);
        const d = src[j]!;
        if (d === "\\") {
          j += 2;
          continue;
        }
        if (d === "[") inClass = true;
        else if (d === "]") inClass = false;
        else if (d === "/" && !inClass) break;
        j++;
      }
      j++;
      while (j < src.length && /[a-z]/i.test(src[j]!)) j++;
      push({ k: "regex", v: src.slice(i, j), s: start, e: j });
      i = j;
      continue;
    }
    // A closing brace of a template expression goes back to the template's text.
    const g = top();
    if (c === "}" && g !== -1 && groups[g]!.kind === "template") {
      const t = templateText(i + 1);
      if (!t) return fail("an unterminated template literal", start);
      stack.pop();
      groups[g]!.close = toks.length;
      push({ k: "tmpl", v: src.slice(i, t.end), s: start, e: t.end, closes: g, ...(t.open ? { open: true } : {}) });
      if (t.open) {
        groups.push({ kind: "template", open: toks.length - 1, close: -1 });
        stack.push(groups.length - 1);
      }
      i = t.end;
      continue;
    }
    const p = PUNCTUATORS.find((x) => src.startsWith(x, i) && !(x === "?." && /[0-9]/.test(src[i + 2] ?? "")));
    if (!p) return fail(`a character this reader does not read (${JSON.stringify(c)})`, i);
    if (p === "{" || p === "(" || p === "[") {
      const kind: GroupKind = p === "(" ? "paren" : p === "[" ? "bracket" : braceKind();
      if (p === "{" && kind === "specifiers") importing = false;
      if (p === "{") caseDepth = -1;
      push({ k: "punct", v: p, s: start, e: i + 1 });
      groups.push({ kind, open: toks.length - 1, close: -1 });
      stack.push(groups.length - 1);
    } else if (p === "}" || p === ")" || p === "]") {
      const want = p === "}" ? ["block", "object", "class", "type", "enum", "specifiers"] : p === ")" ? ["paren"] : ["bracket"];
      if (g === -1 || !want.includes(groups[g]!.kind)) return fail(`an unmatched ${p}`, i);
      stack.pop();
      groups[g]!.close = toks.length;
      push({ k: "punct", v: p, s: start, e: i + 1, closes: g });
    } else {
      const tok = push({ k: "punct", v: p, s: start, e: i + p.length });
      if (p === ":" && caseDepth === stack.length) {
        tok.caseColon = true;
        caseDepth = -1;
      }
      if (p === ";") {
        importing = false;
        caseDepth = -1;
      }
    }
    i += p.length;
  }
  if (stack.length > 0) {
    const open = groups[top()]!;
    return fail(`an unclosed ${open.kind === "template" ? "template literal" : (toks[open.open]?.v ?? "bracket")}`, toks[open.open]?.s ?? src.length);
  }
  return { toks, groups };
}

/** A string token's text between its quotes, or null when it holds an escape (never matched). */
function stringValue(t: Tok): string | null {
  const inner = t.v.slice(1, -1);
  return inner.includes("\\") ? null : inner;
}

// ---------------------------------------------------------------------------
// replace-import
// ---------------------------------------------------------------------------

/** The indexes of string tokens that name a module: after `from`, `import`, or as the argument of `import(` or `require(`. */
function specifierStrings(toks: readonly Tok[]): number[] {
  const out: number[] = [];
  const word = (t: Tok | undefined, ...words: string[]): boolean => t !== undefined && t.k === "ident" && words.includes(t.v);
  const notMember = (at: number): boolean => {
    const p = toks[at - 1];
    return !(p && p.k === "punct" && (p.v === "." || p.v === "?."));
  };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k !== "str") continue;
    const p = toks[i - 1];
    if (word(p, "from", "import") && notMember(i - 1)) out.push(i);
    else if (p?.v === "(" && word(toks[i - 2], "import", "require") && notMember(i - 2) && (toks[i + 1]?.v === ")" || toks[i + 1]?.v === ",")) out.push(i);
  }
  return out;
}

function replaceImport(src: string, lexed: Lexed, args: Record<string, string | boolean>): string {
  const from = String(args.from);
  const to = String(args.to);
  const edits: Edit[] = [];
  for (const i of specifierStrings(lexed.toks)) {
    const t = lexed.toks[i]!;
    const value = stringValue(t);
    if (value === null) continue;
    const next = value === from ? to : args.prefix === true && value.startsWith(from) ? to + value.slice(from.length) : null;
    if (next !== null) edits.push({ s: t.s + 1, e: t.e - 1, text: next });
  }
  return applyEdits(src, edits);
}

// ---------------------------------------------------------------------------
// rename-identifier
// ---------------------------------------------------------------------------

interface Edit {
  s: number;
  e: number;
  text: string;
}

function applyEdits(src: string, edits: Edit[]): string {
  if (edits.length === 0) return src;
  edits.sort((a, b) => a.s - b.s);
  let out = "";
  let at = 0;
  for (const ed of edits) {
    if (ed.s < at) continue;
    out += src.slice(at, ed.s) + ed.text;
    at = ed.e;
  }
  return out + src.slice(at);
}

/** Where an identifier token sits: a name to rename (`ref`), a shorthand property (`shorthand`), or a name that is not the binding (`key`, `member`). */
type Role = "ref" | "shorthand" | "key" | "member";

/** Is `path`'s relative module `spec` covered by the recipe (any of the files it may resolve to)? Bare specifiers never are. */
function moduleCovered(recipe: Pick<Recipe, "scope">, path: Path, spec: string): boolean {
  if (!spec.startsWith("./") && !spec.startsWith("../") && spec !== "." && spec !== "..") return false;
  const parts = path.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (parts.length === 0) return false;
      parts.pop();
    } else parts.push(seg);
  }
  const target = parts.join("/");
  const stem = target.replace(/\.(?:[cm]?js|jsx)$/i, "");
  const candidates = [target, ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "d.ts"].map((x) => `${stem}.${x}`), `${target}/index.ts`, `${target}/index.js`];
  return candidates.some((c) => recipeCovers(recipe, c));
}

/** The token after `i` (skipping nothing: comments are not tokens). */
function at(toks: readonly Tok[], i: number): Tok | undefined {
  return toks[i];
}

/** A token that ends an operand (a member before a line break then starts the next member). */
function endsOperand(t: Tok | undefined): boolean {
  if (!t) return false;
  if (t.k === "ident" || t.k === "num" || t.k === "str" || t.k === "regex" || t.k === "private") return true;
  if (t.k === "tmpl") return !t.open;
  return t.v === ")" || t.v === "]" || t.v === "}";
}

/** The role of identifier token `i` (see Role). */
function roleOf(lexed: Lexed, i: number, namespaces: ReadonlySet<string>): Role {
  const { toks, groups } = lexed;
  const t = toks[i]!;
  const prev = at(toks, i - 1);
  const next = at(toks, i + 1);
  if (prev && prev.k === "punct" && (prev.v === "." || prev.v === "?.")) {
    // A member read through a namespace import of a module in scope names the module's export.
    const base = at(toks, i - 2);
    const before = at(toks, i - 3);
    const baseIsName = base !== undefined && base.k === "ident" && namespaces.has(base.v) && !(before && before.k === "punct" && (before.v === "." || before.v === "?."));
    return baseIsName && prev.v === "." ? "ref" : "member";
  }
  const g = t.g === -1 ? undefined : groups[t.g];
  if (!g) return "ref";
  const kind = g.kind;
  if (kind !== "object" && kind !== "type" && kind !== "class" && kind !== "enum") return "ref";
  const startsMember = (j: number): boolean => {
    const b = toks[j];
    return j === g.open || (b !== undefined && b.k === "punct" && (b.v === "," || b.v === ";")) || (b !== undefined && b.k === "ident" && MODIFIERS.has(b.v));
  };
  const strict = i - 1 === g.open || (prev !== undefined && prev.k === "punct" && prev.v === ",");
  const modifier = prev !== undefined && prev.k === "ident" && MODIFIERS.has(prev.v) && prev.g === t.g;
  // A generator method's star: `{ *name() {} }`, never a multiplication.
  const star = prev !== undefined && prev.k === "punct" && prev.v === "*" && startsMember(i - 2);
  const loose =
    strict ||
    modifier ||
    star ||
    (prev !== undefined && prev.k === "punct" && prev.v === ";") ||
    (t.nl && endsOperand(prev)) ||
    (kind !== "object" && prev !== undefined && prev.k === "punct" && (prev.v === "}" || prev.v === ")"));
  const nv = next?.k === "punct" ? next.v : "";
  const optional = nv === "?" && (toks[i + 2]?.v === ":" || toks[i + 2]?.v === "(");
  if (kind === "object") {
    if (strict && (nv === "," || nv === "}" || nv === "=")) return "shorthand";
    if (loose && (nv === ":" || optional)) return "key";
    if ((strict || modifier || star) && (nv === "(" || nv === "<")) return "key";
    return "ref";
  }
  if (kind === "type") return loose && (nv === ":" || optional || nv === "(" || nv === "<") ? "key" : "ref";
  if (kind === "enum") return loose && (nv === "=" || nv === "," || nv === "}" || next?.nl === true) ? "key" : "ref";
  // A class body: a name that starts a member is the member's name.
  if (loose && (nv === ":" || nv === "?" || nv === "!" || nv === "(" || nv === "<" || nv === "=" || nv === ";" || nv === "}" || next === undefined || next.nl)) return "key";
  return "ref";
}

/** One import or export specifier list: its entries (token indexes), whether it imports, and its module (null: none). */
function specifierLists(lexed: Lexed): Array<{ group: number; imports: boolean; module: string | null; entries: number[][] }> {
  const { toks, groups } = lexed;
  const out: Array<{ group: number; imports: boolean; module: string | null; entries: number[][] }> = [];
  groups.forEach((g, gi) => {
    if (g.kind !== "specifiers") return;
    // Walk back over `type`, a default import and its comma to the statement's keyword.
    let imports = false;
    for (let b = g.open - 1; b >= 0 && b >= g.open - 4; b--) {
      const w = toks[b]!;
      if (w.k === "ident" && (w.v === "import" || w.v === "export")) {
        imports = w.v === "import";
        break;
      }
    }
    const from = toks[g.close + 1];
    const str = toks[g.close + 2];
    const module = from && from.k === "ident" && from.v === "from" && str && str.k === "str" ? stringValue(str) : null;
    const entries: number[][] = [];
    let cur: number[] = [];
    for (let j = g.open + 1; j < g.close; j++) {
      const t = toks[j]!;
      if (t.g !== gi) continue;
      if (t.k === "punct" && t.v === ",") {
        if (cur.length > 0) entries.push(cur);
        cur = [];
      } else cur.push(j);
    }
    if (cur.length > 0) entries.push(cur);
    out.push({ group: gi, imports, module, entries });
  });
  return out;
}

function renameIdentifier(src: string, lexed: Lexed, path: Path, recipe: Recipe): RecipeOutput {
  const from = String(recipe.args.from);
  const to = String(recipe.args.to);
  const { toks } = lexed;
  if (!toks.some((t) => t.k === "ident" && t.v === from)) return { ok: true, text: src };
  // Namespace imports of modules in scope: `import * as ns from "./a"` makes `ns.from` a reference.
  const namespaces = new Set<string>();
  for (let i = 0; i + 4 < toks.length; i++) {
    const t = toks[i]!;
    if (t.k === "punct" && t.v === "*" && toks[i + 1]?.v === "as" && toks[i + 2]?.k === "ident") {
      const f = toks[i + 3];
      const s = toks[i + 4];
      // Back over a default import and its comma (`import d, * as ns`) to the statement's keyword.
      let k = i - 1;
      while (k >= 0 && k >= i - 3 && (toks[k]!.k === "ident" || toks[k]!.v === ",") && toks[k]!.v !== "import" && toks[k]!.v !== "export") k--;
      const imported = k >= 0 && toks[k]!.v === "import";
      const value = s && s.k === "str" ? stringValue(s) : null;
      if (imported && f?.v === "from" && value !== null && moduleCovered(recipe, path, value)) namespaces.add(toks[i + 2]!.v);
    }
  }
  const edits: Edit[] = [];
  const handled = new Set<number>();
  let taken = false;
  for (const list of specifierLists(lexed)) {
    const covered = list.module === null ? !list.imports : moduleCovered(recipe, path, list.module);
    for (const entry of list.entries) {
      const names = entry.filter((j) => toks[j]!.k === "ident" && !(toks[j]!.v === "type" && j === entry[0] && entry.length > 1));
      for (const j of entry) handled.add(j);
      const asAt = names.findIndex((j) => toks[j]!.v === "as");
      const head = asAt === -1 ? names[0] : names[asAt - 1];
      const alias = asAt === -1 ? undefined : names[asAt + 1];
      // The new name is taken where the list binds it here (an import's local name) or exports it already.
      const binds = list.imports ? [alias ?? head] : [head, alias ?? head];
      if (binds.some((j) => j !== undefined && toks[j]!.v === to)) taken = true;
      if (covered) {
        for (const j of names) if (toks[j]!.v === from) edits.push({ s: toks[j]!.s, e: toks[j]!.e, text: to });
        continue;
      }
      // A module outside the scope keeps its own export name.
      if (alias !== undefined) {
        if (toks[alias]!.v === from) edits.push({ s: toks[alias]!.s, e: toks[alias]!.e, text: to });
      } else if (head !== undefined && toks[head]!.v === from) {
        edits.push({ s: toks[head]!.s, e: toks[head]!.e, text: `${from} as ${to}` });
      }
    }
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.k !== "ident" || handled.has(i) || (t.v !== from && t.v !== to)) continue;
    const role = roleOf(lexed, i, namespaces);
    if (t.v === to) {
      if (role === "ref" || role === "shorthand") taken = true;
      continue;
    }
    if (role === "ref") edits.push({ s: t.s, e: t.e, text: to });
    else if (role === "shorthand") edits.push({ s: t.s, e: t.e, text: `${from}: ${to}` });
  }
  if (edits.length === 0) return { ok: true, text: src };
  if (taken) return { ok: false, reason: "name-taken", detail: `the file already uses ${to} as an identifier, so renaming ${from} to it could change what a name means` };
  return { ok: true, text: applyEdits(src, edits) };
}
