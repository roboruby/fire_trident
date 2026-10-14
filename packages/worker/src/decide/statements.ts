import type { Path, TopStatements } from "@fire_trident/core";
import { sha1Hex } from "@fire_trident/core";
import { PROOF_FILE, readScript, type CodeToken } from "./comments.ts";

/**
 * The top-level statements of a script file, for the growth check of import-name revalidation (core
 * onlyGrew): a change stale only through files it read lands when each of them only gained top-level
 * declarations since the version it read, so the trunk writer needs each version as a list of statements
 * it can compare one by one.
 * - The file is read with the comment-only proof's reader (comments.ts readScript), which reads code
 *   exactly and refuses what it cannot read for sure (JSX, a slash it cannot place, an unterminated
 *   literal, unbalanced brackets). A refused file has no statements, and its readers go back.
 * - Statements are cut at bracket depth zero: after a ";", and at a line break where the token before
 *   can end a statement (a value, a ")", "]" or "}", a name that expects nothing more) and the token after
 *   can only start one (import, export, const, let, var, function, class, type, interface, enum, declare,
 *   namespace, module, abstract, async, switch, try, return, throw, break, continue, debugger, a
 *   decorator's "@", or after a "}" any name but else, catch, finally, while, in, instanceof, as,
 *   satisfies and from): there automatic semicolon insertion ends the statement whatever the code meant.
 *   Anything else stays in one statement. Cutting too little only makes the check stricter (a declaration
 *   added inside a run reads as an edit); cutting too much could hide an edit, so where a cut could be
 *   wrong the file is refused: a top-level if, for, while, do or with (a bare body may follow the header
 *   on the next line), a labeled statement, a decorator that reaches no class.
 * - Each statement is hashed from its tokens and the line breaks between them (comments and white space
 *   do not count), and marked as a declaration when it starts with import ... from, export, const, let,
 *   var, function, class, type, interface, enum, declare, namespace, module, abstract class, async
 *   function or a decorator. A hashbang and the directives after it ("use strict") are the prologue,
 *   which holds only in place.
 * Pure: no I/O.
 */

/** How the reader is driven, from the path: versions read in different modes are never compared. */
function modeOf(path: Path): string {
  return /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase() ?? "";
}

/** Hex characters of a statement's hash kept: 64 bits, enough to tell edits apart without weighing on the cache. */
const HASH_CHARS = 16;
/** Statements read per file at most; a longer file has none (its readers go back). */
export const MAX_STATEMENTS = 20_000;

/** Words that can only start a statement: after a line break they never continue the one before. */
const STARTS: ReadonlySet<string> = new Set([
  "import",
  "export",
  "const",
  "let",
  "var",
  "function",
  "class",
  "type",
  "interface",
  "enum",
  "declare",
  "namespace",
  "module",
  "abstract",
  "async",
  "if",
  "for",
  "while",
  "do",
  "with",
  "switch",
  "try",
  "return",
  "throw",
  "break",
  "continue",
  "debugger",
]);
/** Names that can continue a statement after a "}" on the line before; any other name starts a new one there. */
const CONTINUES_AFTER_BRACE: ReadonlySet<string> = new Set(["else", "catch", "finally", "while", "in", "instanceof", "as", "satisfies", "from"]);
/** Statements whose body may follow the header on the next line without braces: a cut there could be wrong. */
const HEADED: ReadonlySet<string> = new Set(["if", "for", "while", "do", "with"]);
/** Words after which a statement has not ended: the next line continues it. */
const EXPECTS_MORE: ReadonlySet<string> = new Set([
  "const",
  "let",
  "var",
  "export",
  "import",
  "function",
  "class",
  "extends",
  "implements",
  "new",
  "typeof",
  "in",
  "of",
  "as",
  "satisfies",
  "type",
  "interface",
  "enum",
  "declare",
  "abstract",
  "async",
  "await",
  "yield",
  "throw",
  "case",
  "else",
  "do",
  "delete",
  "void",
  "instanceof",
  "from",
  "default",
  "static",
  "get",
  "set",
  "keyof",
  "infer",
  "is",
  "readonly",
  "unique",
  "asserts",
  "accessor",
  "override",
  "public",
  "private",
  "protected",
  "namespace",
  "module",
  "global",
  "using",
]);
/** Words that declare, when they start a statement (import and the contextual ones are decided by what follows). */
const DECLARES: ReadonlySet<string> = new Set(["export", "const", "let", "var", "function", "class", "interface", "enum"]);

const QUOTE = 34;
const HASH = 35;
const DOLLAR = 36;
const APOSTROPHE = 39;
const DOT = 46;
const SLASH = 47;
const BACKQUOTE = 96;
const CLOSE_BRACE = 125;

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57;
}

function isNameStart(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === DOLLAR || code === 95 || code >= 0x80;
}

/** A template token that opens a substitution (its text ends in "${"), so what follows is inside it. */
function opensSubstitution(text: string): boolean {
  return text.length > 1 && text.endsWith("${") && (text.charCodeAt(0) === BACKQUOTE || text.charCodeAt(0) === CLOSE_BRACE);
}

/** A template token that closes a substitution (it starts with "}" and is more than the punctuator). */
function closesSubstitution(text: string): boolean {
  return text.length > 1 && text.charCodeAt(0) === CLOSE_BRACE;
}

/** Can a statement end after this token? A value, a closing bracket, or a name that expects nothing more. */
function canEnd(text: string): boolean {
  if (text === ")" || text === "]" || text === "}") return true;
  const c = text.charCodeAt(0);
  if (c === QUOTE || c === APOSTROPHE) return true;
  if (c === BACKQUOTE || c === CLOSE_BRACE) return text.length > 1 && text.endsWith("`");
  if (isDigit(c) || (c === DOT && isDigit(text.charCodeAt(1)))) return true;
  if (c === SLASH) return text.length > 2;
  if (isNameStart(c) || c === HASH) return !EXPECTS_MORE.has(text);
  return false;
}

/** Can this token only start a statement, never continue the one before it (`prev`)? */
function mustStart(prev: string, text: string): boolean {
  return text === "@" || STARTS.has(text) || (prev === "}" && isNameStart(text.charCodeAt(0)) && !CONTINUES_AFTER_BRACE.has(text));
}

/** Does a statement (its tokens) declare rather than run something? */
function declares(t: readonly CodeToken[]): boolean {
  const first = t[0]?.text ?? "";
  const second = t[1]?.text ?? "";
  const named = second !== "" && (isNameStart(second.charCodeAt(0)) || second.charCodeAt(0) === QUOTE || second.charCodeAt(0) === APOSTROPHE);
  if (first === ";" || first === "@" || DECLARES.has(first)) return true;
  // `import x from`, `import { x } from`, `import * as x from`, `import type ...`; not `import("x")`, `import.meta` or `import "x"`.
  if (first === "import") return second === "{" || second === "*" || (second !== "" && isNameStart(second.charCodeAt(0)));
  if (first === "type" || first === "declare" || first === "namespace" || first === "module") return named;
  if (first === "abstract") return second === "class";
  if (first === "async") return second === "function";
  return false;
}

/** A directive at the start of a file: a string on its own, with or without a ";". */
function isDirective(t: readonly CodeToken[]): boolean {
  const c = t[0]?.text.charCodeAt(0);
  return (c === QUOTE || c === APOSTROPHE) && (t.length === 1 || (t.length === 2 && t[1]!.text === ";"));
}

/** The hash of a statement: its tokens, each with its length so no two token lists read alike, and the line breaks between them. */
function hashOf(t: readonly CodeToken[]): string {
  let s = "";
  for (let k = 0; k < t.length; k++) s += `${k > 0 && t[k]!.nl ? "\n" : " "}${t[k]!.text.length}:${t[k]!.text}`;
  return sha1Hex(new TextEncoder().encode(s)).slice(0, HASH_CHARS);
}

/**
 * The top-level statements of a script file (see the module comment), or null when they cannot be read
 * for sure: not a script file, a source the reader refuses, a top-level statement whose cut could be wrong,
 * or more statements than MAX_STATEMENTS.
 */
export function topStatements(path: Path, text: string): TopStatements | null {
  if (!PROOF_FILE.test(path)) return null;
  const r = readScript(path, text);
  if (!r.ok) return null;
  const t = r.tokens;
  /** The index of each statement's first token. */
  const starts: number[] = [];
  let depth = 0;
  /** The current statement began with a decorator and has not reached its class yet: no cut before it does. */
  let decorated = false;
  for (let k = 0; k < t.length; k++) {
    const text = t[k]!.text;
    const prev = k > 0 ? t[k - 1]!.text : null;
    const begins = k === 0 || prev!.startsWith("#!") || (depth === 0 && !decorated && (prev === ";" || (t[k]!.nl && canEnd(prev!) && mustStart(prev!, text))));
    if (begins) {
      if (HEADED.has(text) || t[k + 1]?.text === ":") return null;
      if (starts.length === MAX_STATEMENTS) return null;
      starts.push(k);
      decorated = text === "@";
    } else if (decorated && depth === 0 && text === "class") {
      decorated = false;
    }
    if (text === "(" || text === "[" || text === "{" || opensSubstitution(text)) depth++;
    else if (text === ")" || text === "]" || text === "}" || closesSubstitution(text)) depth--;
  }
  if (decorated) return null;
  const hashes: string[] = [];
  const lines: number[] = [];
  const declared: boolean[] = [];
  for (let s = 0; s < starts.length; s++) {
    const tokens = t.slice(starts[s]!, starts[s + 1] ?? t.length);
    hashes.push(hashOf(tokens));
    lines.push(r.lines[starts[s]!]!);
    declared.push(declares(tokens));
  }
  // The prologue: a hashbang, then directives, each counting only while nothing comes before it.
  let prologue = 0;
  if (t[0]?.text.startsWith("#!")) prologue = 1;
  while (prologue < starts.length && isDirective(t.slice(starts[prologue]!, starts[prologue + 1] ?? t.length))) prologue++;
  return { mode: modeOf(path), hashes, lines, declares: declared, prologue };
}
