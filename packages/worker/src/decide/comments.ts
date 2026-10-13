import type { Path } from "@fire_trident/core";

/**
 * The comment-only proof, a deterministic confirmation like the import proof (mechanical.ts): a change
 * whose every file is an existing JavaScript or TypeScript file (.ts .tsx .js .jsx .mjs .cjs) whose code
 * is the same outside comments and whitespace does not change what that code does.
 * - Code is compared token by token (names, numbers, strings, templates, regular expressions and
 *   punctuators, each by its exact text), together with whether a line break comes before each token:
 *   a line break can end a statement (`return`, then a new line, returns nothing), and a block comment
 *   that holds one counts as one.
 * - The reader refuses what it cannot read exactly instead of guessing: a slash it cannot tell from the
 *   start of a regular expression (after `}`, `++` or `yield`, or at the start of a line after a value),
 *   anything that may be JSX (in every file but .ts), a backslash outside a literal (an escaped name), an
 *   HTML-like comment, an unterminated literal or comment, unbalanced brackets. A file it refuses is not
 *   proven, so a refusal only leaves the change to the other layers.
 * - Tools read some comments, and some of those act on the lines around them: a file that holds a
 *   directive comment anywhere (type-checker, linter, formatter, coverage, bundler, test-runner and
 *   source-map directives, triple-slash references and, in JavaScript files, the JSDoc tags a type
 *   checker reads), changed or not, is not proven.
 * - Nor is one gaining a comment with a bidirectional control character (it can make the code around it
 *   read differently from what it is) or with what looks like a credential.
 * Pure: no I/O.
 */

/** Files the proof reads: JavaScript and TypeScript (declaration files included). */
export const PROOF_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i;
/** Files that may hold JSX: every proof file but .ts. */
const JSX_FILE = /\.(?:tsx|js|jsx|mjs|cjs)$/i;
/** TypeScript files, where a "!" right after a value asserts it is not null. */
const TS_FILE = /\.tsx?$/i;
/** JavaScript files, whose JSDoc types a type checker can read. */
const JS_FILE = /\.(?:js|jsx|mjs|cjs)$/i;
/** Characters the proof reads per change (old and new text together); a larger change is left to the other layers. */
export const MAX_PROOF_CHARS = 2_000_000;

/**
 * Keywords of comments that tools read: type-checker, linter, formatter, coverage, bundler, test-runner
 * and source-map directives. Matched anywhere in a comment and in any case: a false match only means a
 * file is not proven.
 */
const DIRECTIVE =
  /@ts-|eslint|prettier-ignore|istanbul|\bc8\b|\bv8\s{1,8}ignore|@jsx|[#@]__[a-z_]{1,40}__|webpack|@vite|sourcemappingurl|sourceurl|jshint|jslint|global|biome-ignore|deno-|dprint-ignore|tslint|oxlint|@flow\b|\$flow|-environment\b|@refresh\b|@internal\b/i;
/** A triple-slash directive (`/// <reference types="..." />`). */
const TRIPLE_SLASH = /^\/\/\/\s*</;
/** JSDoc tags a type checker reads in JavaScript files. */
const JSDOC_TYPE = /@(?:type|typedef|callback|template|param|arg|argument|returns?|prop|property|enum|this|extends|augments|implements|satisfies|import|overload|override|public|private|protected|readonly)\b/i;
/** Bidirectional control characters: they can make the code around them read differently from what it is. */
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/** A credential-like name given a value (`password = hunter22`, `api_key: "sk-..."`); bounded repeats keep it linear on long comments. */
const CREDENTIAL = /(?:secret|passw(?:or)?d|api[_-]?key|apikey|private[_-]?key|access[_-]?key|token|credential)\w{0,40}["']?[ \t]{0,8}[:=][ \t]{0,8}["'`]?[^\s"'`]{6}/i;

/** One token of code: its exact text, and whether a line break comes between it and the token before. */
export interface CodeToken {
  text: string;
  nl: boolean;
}

/** A file read as code tokens and comments, or why it cannot be read exactly. */
export type ScriptReading = { ok: true; tokens: CodeToken[]; comments: string[] } | { ok: false; why: string };

type Kind = "name" | "private" | "num" | "str" | "tpl" | "tplOpen" | "re" | "punc" | "hashbang";

interface Token extends CodeToken {
  kind: Kind;
  /** A ")" closing the condition of if, while, for or with: a statement, so an expression, may follow. */
  head?: boolean;
}

/** What a slash (or a "<" where JSX may start) means here: a regular expression starts, a value is divided, or this reader cannot tell. */
type SlashMeaning = "regex" | "divide" | "unknown";

/** Words after which an expression starts (after break, continue and debugger a new statement may). */
const BEFORE_EXPRESSION: ReadonlySet<string> = new Set(["return", "typeof", "instanceof", "in", "new", "delete", "void", "throw", "case", "do", "else", "extends", "default", "break", "continue", "debugger"]);
/** Words after which a slash is not decided here: names in some code and keywords in other code, or a syntax error. */
const UNDECIDED: ReadonlySet<string> = new Set(["yield", "await", "of", "let", "if", "for", "while", "with", "switch", "try", "catch", "finally", "function", "class", "var", "const", "import", "export", "enum"]);
/** Keywords whose parenthesized condition a statement follows. */
const HEADS: ReadonlySet<string> = new Set(["if", "while", "for", "with"]);
/** Punctuators of 4, 3, 2 and 1 characters ("/" and "/=" are read with regular expressions, brackets apart). */
const PUNCTUATORS: ReadonlyArray<ReadonlySet<string>> = [
  new Set([">>>="]),
  new Set(["...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??="]),
  new Set(["=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "%=", "&=", "|=", "^=", "<<", ">>", "**"]),
  new Set(["<", ">", "+", "-", "*", "%", "&", "|", "^", "!", "~", "?", ":", "=", ".", "@", "#", ";", ","]),
];
/** Punctuators after which a slash may divide or start a regular expression. */
const UNDECIDED_PUNCTUATORS: ReadonlySet<string> = new Set(["}", "++", "--", ".", "?.", ">", ">>", ">>>", "#", "@"]);
/** A numeric literal, read at least as far as JavaScript reads one, so a number never splits where JavaScript's would not. */
const NUMBER = /(?:0[xX][0-9a-fA-F_]*|0[oO][0-7_]*|0[bB][01_]*|(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9][0-9_]*)(?:[eE][+-]?[0-9_]*)?)n?/y;

const LF = 10;
const CR = 13;
const LS = 0x2028;
const PS = 0x2029;
const BOM = 0xfeff;
const QUOTE = 34;
const HASH = 35;
const DOLLAR = 36;
const APOSTROPHE = 39;
const OPEN_PAREN = 40;
const CLOSE_PAREN = 41;
const STAR = 42;
const DOT = 46;
const SLASH = 47;
const LESS = 60;
const EQUALS = 61;
const GREATER = 62;
const OPEN_BRACKET = 91;
const BACKSLASH = 92;
const CLOSE_BRACKET = 93;
const BACKQUOTE = 96;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;

/** A line terminator: line feed, carriage return, line separator or paragraph separator. */
function isBreak(code: number): boolean {
  return code === LF || code === CR || code === LS || code === PS;
}

/** JavaScript white space (tab, vertical tab, form feed, space, no-break space, byte order mark, Unicode spaces). */
function isSpace(code: number): boolean {
  return code === 9 || code === 11 || code === 12 || code === 32 || code === 0xa0 || code === BOM || code === 0x1680 || (code >= 0x2000 && code <= 0x200a) || code === 0x202f || code === 0x205f || code === 0x3000;
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

/** Can a name start with this character? Every non-ASCII character that is not white space counts, so a name is never cut shorter than JavaScript reads it. */
function isIdStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === DOLLAR || code === 95 || (code >= 0x80 && !isSpace(code) && !isBreak(code));
}

function isIdPart(code: number): boolean {
  return isIdStart(code) || isDigit(code);
}

/** Line breaks in `text` (CR LF counts once). */
function breaks(text: string): number {
  let count = 0;
  for (let k = 0; k < text.length; k++) {
    const d = text.charCodeAt(k);
    if (d === LF || d === LS || d === PS || (d === CR && text.charCodeAt(k + 1) !== LF)) count++;
  }
  return count;
}

/**
 * Read JavaScript or TypeScript source as code tokens and comments, exactly, or say why it cannot be
 * read exactly (see the module comment). Never throws.
 */
export function readScript(path: Path, src: string): ScriptReading {
  const jsx = JSX_FILE.test(path);
  const ts = TS_FILE.test(path);
  const tokens: Token[] = [];
  const comments: string[] = [];
  const open: Array<{ bracket: string; head: boolean }> = [];
  const n = src.length;
  let i = 0;
  let line = 1;
  let nl = false;

  const refuse = (why: string): ScriptReading => ({ ok: false, why: `line ${line}: ${why}` });
  const push = (kind: Kind, text: string, head = false): void => {
    tokens.push(head ? { kind, text, nl, head } : { kind, text, nl });
    nl = false;
    line += breaks(text);
  };
  const isProperty = (k: number): boolean => {
    const d = tokens[k - 1];
    return d?.kind === "punc" && (d.text === "." || d.text === "?.");
  };
  // A "(" after if, while, for, with or `for await` opens a condition: a statement follows its ")".
  const head = (): boolean => {
    const k = tokens.length - 1;
    const p = tokens[k];
    if (p?.kind !== "name" || isProperty(k)) return false;
    if (HEADS.has(p.text)) return true;
    const q = tokens[k - 1];
    return p.text === "await" && q?.kind === "name" && q.text === "for" && !isProperty(k - 1);
  };
  // Token k ends a value on its own (a "!" is decided by bangAsserts).
  const endsValue = (k: number): boolean => {
    const t = tokens[k];
    if (t === undefined) return false;
    if (t.kind === "name") return isProperty(k) || (!BEFORE_EXPRESSION.has(t.text) && !UNDECIDED.has(t.text));
    if (t.kind !== "punc") return t.kind !== "hashbang" && t.kind !== "tplOpen";
    return (t.text === ")" && !t.head) || t.text === "]";
  };
  // In TypeScript a "!" right after a value, on the same line, asserts the value is not null (so a value
  // still ends there); anywhere else it negates what follows. Read back over a run of "!" without recursion.
  const bangAsserts = (k: number): boolean => {
    let j = k;
    while (tokens[j]?.kind === "punc" && tokens[j]!.text === "!") {
      if (tokens[j]!.nl) return false;
      j--;
    }
    return ts && j < k && endsValue(j);
  };
  const meaning = (): SlashMeaning => {
    const k = tokens.length - 1;
    const p = tokens[k];
    if (p === undefined || p.kind === "hashbang" || p.kind === "tplOpen") return "regex";
    // A value ended here. After a line break a statement or a type annotation may have ended instead.
    const value: SlashMeaning = nl ? "unknown" : "divide";
    if (p.kind === "name") {
      if (isProperty(k)) return value;
      if (BEFORE_EXPRESSION.has(p.text)) return "regex";
      if (UNDECIDED.has(p.text)) return "unknown";
      return value;
    }
    if (p.kind !== "punc") return value;
    if (p.text === ")") return p.head ? "regex" : value;
    if (p.text === "]" || (p.text === "!" && bangAsserts(k))) return value;
    return UNDECIDED_PUNCTUATORS.has(p.text) ? "unknown" : "regex";
  };
  // Template text from `start` (a backquote, or the "}" closing a substitution) to its end or its next substitution.
  const template = (start: number): boolean => {
    for (let j = start + 1; j < n; j++) {
      const d = src.charCodeAt(j);
      if (d === BACKSLASH) {
        j++;
      } else if (d === BACKQUOTE) {
        push("tpl", src.slice(start, j + 1));
        i = j + 1;
        return true;
      } else if (d === DOLLAR && src.charCodeAt(j + 1) === OPEN_BRACE) {
        push("tplOpen", src.slice(start, j + 2));
        open.push({ bracket: "${", head: false });
        i = j + 2;
        return true;
      }
    }
    return false;
  };

  if (src.charCodeAt(0) === BOM) i = 1;
  if (src.startsWith("#!", i)) {
    let j = i + 2;
    while (j < n && !isBreak(src.charCodeAt(j))) j++;
    push("hashbang", src.slice(i, j));
    i = j;
  }
  while (i < n) {
    const code = src.charCodeAt(i);
    if (isBreak(code)) {
      nl = true;
      line++;
      i += code === CR && src.charCodeAt(i + 1) === LF ? 2 : 1;
      continue;
    }
    if (isSpace(code)) {
      i++;
      continue;
    }
    const next = src.charCodeAt(i + 1);
    if (code === SLASH && next === SLASH) {
      let j = i + 2;
      while (j < n && !isBreak(src.charCodeAt(j))) j++;
      comments.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (code === SLASH && next === STAR) {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return refuse("a comment that never ends");
      const text = src.slice(i, end + 2);
      comments.push(text);
      const b = breaks(text);
      if (b > 0) {
        nl = true;
        line += b;
      }
      i = end + 2;
      continue;
    }
    if (code === QUOTE || code === APOSTROPHE) {
      let j = i + 1;
      for (;;) {
        if (j >= n) return refuse("a string that never ends");
        const d = src.charCodeAt(j);
        if (d === code) break;
        if (d === BACKSLASH) j += src.charCodeAt(j + 1) === CR && src.charCodeAt(j + 2) === LF ? 3 : 2;
        else if (d === LF || d === CR) return refuse("a string that never ends");
        else j++;
      }
      push("str", src.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (code === BACKQUOTE) {
      if (!template(i)) return refuse("a template literal that never ends");
      continue;
    }
    if (isDigit(code) || (code === DOT && isDigit(next))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      const j = i + (m?.[0].length ?? 1);
      if (j < n && (isIdPart(src.charCodeAt(j)) || src.charCodeAt(j) === BACKSLASH)) return refuse("a number that runs into a name");
      push("num", src.slice(i, j));
      i = j;
      continue;
    }
    if (isIdStart(code) || (code === HASH && isIdStart(next))) {
      let j = i + 1;
      while (j < n && isIdPart(src.charCodeAt(j))) j++;
      if (src.charCodeAt(j) === BACKSLASH) return refuse("an escaped name");
      push(code === HASH ? "private" : "name", src.slice(i, j));
      i = j;
      continue;
    }
    if (code === BACKSLASH) return refuse("a backslash outside a string, template or regular expression");
    if (code === OPEN_PAREN || code === OPEN_BRACKET || code === OPEN_BRACE) {
      open.push({ bracket: src[i]!, head: code === OPEN_PAREN && head() });
      push("punc", src[i]!);
      i++;
      continue;
    }
    if (code === CLOSE_PAREN || code === CLOSE_BRACKET || code === CLOSE_BRACE) {
      const top = open.pop();
      if (code === CLOSE_BRACE && top?.bracket === "${") {
        if (!template(i)) return refuse("a template literal that never ends");
        continue;
      }
      const want = code === CLOSE_PAREN ? "(" : code === CLOSE_BRACKET ? "[" : "{";
      if (top?.bracket !== want) return refuse("unbalanced brackets");
      push("punc", src[i]!, top.head);
      i++;
      continue;
    }
    if (code === SLASH) {
      const m = meaning();
      if (m === "unknown") return refuse("a slash that may divide or start a regular expression");
      if (m === "divide") {
        const text = next === EQUALS ? "/=" : "/";
        push("punc", text);
        i += text.length;
        continue;
      }
      let j = i + 1;
      let inClass = false;
      for (;;) {
        if (j >= n || isBreak(src.charCodeAt(j))) return refuse("a regular expression that never ends");
        const d = src.charCodeAt(j);
        if (d === BACKSLASH) {
          if (j + 1 >= n || isBreak(src.charCodeAt(j + 1))) return refuse("a regular expression that never ends");
          j += 2;
          continue;
        }
        if (d === OPEN_BRACKET) inClass = true;
        else if (d === CLOSE_BRACKET) inClass = false;
        else if (d === SLASH && !inClass) break;
        j++;
      }
      j++;
      while (j < n && isIdPart(src.charCodeAt(j))) j++;
      if (src.charCodeAt(j) === BACKSLASH) return refuse("an escaped regular expression flag");
      push("re", src.slice(i, j));
      i = j;
      continue;
    }
    if (code === LESS) {
      if (src.startsWith("<!--", i)) return refuse("an HTML-like comment");
      if (jsx && meaning() !== "divide") return refuse("what may be JSX, which this proof does not read");
    }
    let text = "";
    for (let len = 4; len >= 1 && text === ""; len--) {
      const s = src.slice(i, i + len);
      if (s.length === len && PUNCTUATORS[4 - len]!.has(s) && !(s === "?." && isDigit(src.charCodeAt(i + 2)))) text = s;
    }
    if (text === "") return refuse("a character that is not JavaScript");
    if (text === "--" && src.charCodeAt(i + 2) === GREATER) return refuse("an HTML-like comment");
    push("punc", text);
    i += text.length;
  }
  if (open.length > 0) return refuse("unbalanced brackets");
  return { ok: true, tokens: tokens.map((t) => ({ text: t.text, nl: t.nl })), comments };
}

/** Same code: the same tokens, with a line break before the same ones (the first token's does not matter). */
export function sameCode(a: readonly CodeToken[], b: readonly CodeToken[]): boolean {
  if (a.length !== b.length) return false;
  for (let k = 0; k < a.length; k++) {
    if (a[k]!.text !== b[k]!.text || (k > 0 && a[k]!.nl !== b[k]!.nl)) return false;
  }
  return true;
}

/** The directive keyword a comment holds (see DIRECTIVE), or null. */
export function directiveIn(path: Path, comment: string): string | null {
  if (TRIPLE_SLASH.test(comment)) return "///";
  const m = DIRECTIVE.exec(comment) ?? (JS_FILE.test(path) ? JSDOC_TYPE.exec(comment) : null);
  return m ? m[0].slice(0, 40) : null;
}

/** Comments of `after` that `before` does not have (each comment counted as many times as it occurs). */
function gainedComments(before: readonly string[], after: readonly string[]): string[] {
  const left = new Map<string, number>();
  for (const c of before) left.set(c, (left.get(c) ?? 0) + 1);
  const out: string[] = [];
  for (const c of after) {
    const k = left.get(c) ?? 0;
    if (k > 0) left.set(c, k - 1);
    else out.push(c);
  }
  return out;
}

/** Why a file whose code is unchanged is still not proven, or null. */
function commentProblem(path: Path, before: readonly string[], after: readonly string[]): string | null {
  for (const c of [...before, ...after]) {
    const d = directiveIn(path, c);
    if (d !== null) return `holds a directive comment that tools read ("${d}")`;
  }
  const gained = gainedComments(before, after);
  if (gained.some((c) => BIDI.test(c))) return "gains a comment with a bidirectional control character";
  if (gained.some((c) => CREDENTIAL.test(c))) return "gains a comment that looks like it holds a credential";
  return null;
}

/** One written file as the proof reads it (`before` null: new or unreadable; `after` null: deleted or unreadable). */
export interface ProofFile {
  path: Path;
  before: string | null;
  after: string | null;
  unreadable?: boolean;
  binary?: boolean;
}

/** What the comment-only proof concluded about a change. */
export interface CommentProof {
  /**
   * pass: every changed file changes only comments and whitespace, and none is disqualified;
   * blocked: the code is unchanged, but a file holds a directive comment or gains a suspect one;
   * no: not a change to existing script files' comments and whitespace (or not one this proof reads).
   */
  verdict: "pass" | "blocked" | "no";
  /** The changed files (pass and blocked). */
  files: Path[];
  reasons: string[];
}

/**
 * The comment-only proof for a change (see the module comment). Files whose text did not change are
 * skipped; every other file must be an existing .ts, .tsx, .js, .jsx, .mjs or .cjs file with readable
 * old and new text whose code is unchanged.
 */
export function commentOnlyProof(files: readonly ProofFile[], maxChars = MAX_PROOF_CHARS): CommentProof {
  const no = (why: string): CommentProof => ({ verdict: "no", files: [], reasons: [why] });
  const changed: Path[] = [];
  const blocked: string[] = [];
  let budget = maxChars;
  for (const f of files) {
    if (f.unreadable || f.binary) return no(`${f.path} cannot be read as text`);
    if (f.before !== null && f.before === f.after) continue;
    if (!PROOF_FILE.test(f.path)) return no(`${f.path} is not a JavaScript or TypeScript file`);
    if (f.before === null) return no(`${f.path} is new (or its old text cannot be read)`);
    if (f.after === null) return no(`${f.path} is deleted`);
    budget -= f.before.length + f.after.length;
    if (budget < 0) return no(`the change is larger than this proof reads (${maxChars} characters)`);
    const was = readScript(f.path, f.before);
    if (!was.ok) return no(`${f.path} before the change, ${was.why}`);
    const now = readScript(f.path, f.after);
    if (!now.ok) return no(`${f.path}, ${now.why}`);
    if (!sameCode(was.tokens, now.tokens)) return no(`${f.path} changes code, not only comments and whitespace`);
    changed.push(f.path);
    const why = commentProblem(f.path, was.comments, now.comments);
    if (why) blocked.push(`${f.path} ${why}`);
  }
  if (changed.length === 0) return no("nothing changed");
  if (blocked.length > 0) return { verdict: "blocked", files: changed, reasons: blocked };
  const which = `${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ` and ${changed.length - 5} more` : ""}`;
  return {
    verdict: "pass",
    files: changed,
    reasons: [`${changed.length} file${changed.length === 1 ? "" : "s"} proven comment-only (${which}): the code's tokens and the line breaks between them are unchanged, and no comment there is a directive tools read`],
  };
}
