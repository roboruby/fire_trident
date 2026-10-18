/**
 * A small reader of a TypeScript or JavaScript module's top-level declarations, for the review view's deterministic
 * acceptance checks (decide/keepcheck.ts, FT_REVIEW_VIEW): what the module exports, with each function's parameters and
 * return type, each interface's members, each type alias's type and each constant's type and value, as written. It reads
 * text only, with no compiler: comments are blanked, and strings, template literals and regular expressions are stepped
 * over when brackets are matched. A module it cannot read cleanly says so (`complete` false), so nothing is concluded
 * from what it did not see. Types are compared as text (sameType): equal after normalizing, different only when both
 * sides are plain enough to be sure, and unknown otherwise. Pure: no I/O.
 */

/** One parameter of a signature: its text, whether it is a rest or optional parameter, and its type (null when not annotated). */
export interface TsParam {
  text: string;
  rest: boolean;
  optional: boolean;
  /** The annotated type, or the primitive type of a literal default (`= true` is boolean); null otherwise. */
  type: string | null;
}

/** A function's signature as written. */
export interface TsSignature {
  /** The type parameters with their brackets ("<T>"), or "". */
  typeParams: string;
  params: TsParam[];
  /** The return type; null when not annotated. */
  returns: string | null;
  /** The signature on one line, for messages: `name(a: A, b?: B): R`. */
  text: string;
}

/** One member of an interface or an object type. */
export interface TsMember {
  name: string;
  optional: boolean;
  /** Its type (a method's as a function type); null when not annotated. */
  type: string | null;
}

/** What a top-level name declares. */
export type TsDeclKind = "function" | "const" | "interface" | "type" | "class" | "enum" | "namespace" | "reexport" | "other";

/** One top-level declaration. */
export interface TsDecl {
  name: string;
  kind: TsDeclKind;
  /** Functions: each signature (an overload list has several); a constant holding an arrow or function expression has one. */
  signatures: TsSignature[];
  /** Constants: the annotated type; type aliases: the aliased type. Null when there is none. */
  type: string | null;
  /** Constants: the initializer as written, null when there is none. */
  value: string | null;
  /** Interfaces and type aliases of an object type: the members; null when there are none or they could not be read. */
  members: TsMember[] | null;
  /** An interface that extends another: members it does not list may be inherited. */
  inherits?: boolean;
}

/** What the reader found in one module. */
export interface TsModule {
  /** Every top-level declaration by name, exported or not. */
  local: Map<string, TsDecl[]>;
  /** Every exported name with its declarations (one re-exported from another file is kind `reexport`). */
  exported: Map<string, TsDecl[]>;
  /** Every export was read: the text scanned cleanly, and there is no `export *`, `export =` or CommonJS export. */
  complete: boolean;
  /** The names its imports bind; null when an import could not be read. */
  imported: Set<string> | null;
  /** The text with comments blanked. */
  clean: string;
}

/** Characters after which a slash starts a regular expression rather than a division. */
const BEFORE_REGEX = new Set("(,=:[!&|?{};+-*%<>~^".split(""));
const WORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);
const IDENT = /^[A-Za-z_$][\w$]*/;
const WORD_CHAR = /[\w$]/;

/**
 * The text with comments blanked (`clean`), and the same with the insides of strings, template literals and regular
 * expressions blanked too (`mask`), both the length of the text with newlines kept; `ok` false when a comment, string or
 * bracket was left open.
 */
export function scanSource(text: string): { clean: string; mask: string; ok: boolean } {
  const n = text.length;
  const clean = text.split("");
  const mask = text.split("");
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b; k++) {
      if (text[k] === "\n") continue;
      clean[k] = " ";
      mask[k] = " ";
    }
  };
  const hide = (a: number, b: number): void => {
    for (let k = a; k < b; k++) if (text[k] !== "\n") mask[k] = " ";
  };
  // The brace depth at each open template substitution ("${"): the "}" back at that depth closes it.
  const substitutions: number[] = [];
  let depth = 0;
  let ok = true;
  let prev = "";
  // A template literal's text from `from` to its closing backtick, or to the next "${".
  const template = (from: number): number => {
    let j = from;
    while (j < n) {
      const ch = text[j];
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === "`") {
        hide(from, j);
        return j + 1;
      }
      if (ch === "$" && text[j + 1] === "{") {
        hide(from, j);
        substitutions.push(depth);
        return j + 2;
      }
      j++;
    }
    ok = false;
    hide(from, n);
    return n;
  };
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    const d = text[i + 1];
    if (c === "/" && d === "/") {
      const j = text.indexOf("\n", i);
      const end = j < 0 ? n : j;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === "/" && d === "*") {
      const j = text.indexOf("*/", i + 2);
      if (j < 0) ok = false;
      const end = j < 0 ? n : j + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      if (j >= n || text[j] !== c) ok = false;
      hide(i + 1, Math.min(j, n));
      i = j + 1;
      prev = "lit";
      continue;
    }
    if (c === "`") {
      i = template(i + 1);
      prev = "lit";
      continue;
    }
    if (c === "/" && (prev === "" || BEFORE_REGEX.has(prev) || WORDS_BEFORE_REGEX.has(prev))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && text[j] !== "\n") {
        const ch = text[j];
        if (ch === "\\") {
          j += 2;
          continue;
        }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) break;
        j++;
      }
      if (j >= n || text[j] !== "/") {
        ok = false;
        prev = "/";
        i++;
        continue;
      }
      hide(i + 1, j);
      j++;
      while (j < n && /[a-z]/i.test(text[j]!)) j++;
      i = j;
      prev = "lit";
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      if (substitutions.length > 0 && substitutions[substitutions.length - 1] === depth) {
        substitutions.pop();
        i = template(i + 1);
        prev = "lit";
        continue;
      }
      depth--;
      if (depth < 0) ok = false;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (WORD_CHAR.test(c)) {
      let j = i + 1;
      while (j < n && WORD_CHAR.test(text[j]!)) j++;
      prev = text.slice(i, j);
      i = j;
      continue;
    }
    prev = c;
    i++;
  }
  if (depth !== 0 || substitutions.length > 0) ok = false;
  return { clean: clean.join(""), mask: mask.join(""), ok };
}

/** The index after the string literal opening at `i` (quote, apostrophe or backtick); -1 when it is not closed. */
function skipString(s: string, i: number): number {
  const q = s[i];
  for (let j = i + 1; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === q) return j + 1;
    if (s[j] === "\n" && q !== "`") return -1;
  }
  return -1;
}

/**
 * The index after the bracket matching the one at `i` ("(", "[", "{" or "<"), stepping over strings when `quotes`; -1 when
 * it is not closed. Angle brackets count only for an opening "<", and the ">" of an arrow ("=>") never closes one.
 */
export function pair(s: string, i: number, quotes = true): number {
  const open = s[i];
  if (open === "<") {
    let d = 0;
    for (let j = i; j < s.length; j++) {
      const ch = s[j]!;
      if (quotes && (ch === '"' || ch === "'" || ch === "`")) {
        const e = skipString(s, j);
        if (e < 0) return -1;
        j = e - 1;
        continue;
      }
      if (ch === "(" || ch === "[" || ch === "{") {
        const e = pair(s, j, quotes);
        if (e < 0) return -1;
        j = e - 1;
        continue;
      }
      if (ch === "<") d++;
      else if (ch === ">" && s[j - 1] !== "=") {
        d--;
        if (d === 0) return j + 1;
      } else if (ch === ")" || ch === "]" || ch === "}" || ch === ";") return -1;
    }
    return -1;
  }
  if (open !== "(" && open !== "[" && open !== "{") return -1;
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const ch = s[j]!;
    if (quotes && (ch === '"' || ch === "'" || ch === "`")) {
      const e = skipString(s, j);
      if (e < 0) return -1;
      j = e - 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") d++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      d--;
      if (d === 0) return j + 1;
      if (d < 0) return -1;
    }
  }
  return -1;
}

/** The index of the first character at or after `i` that is not white space. */
function ws(s: string, i: number): number {
  while (i < s.length && /\s/.test(s[i]!)) i++;
  return i;
}

/** The identifier at `i`, or "". */
function wordAt(s: string, i: number): string {
  return IDENT.exec(s.slice(i, i + 200))?.[0] ?? "";
}

/** A word at `i` that is exactly `w` (not the start of a longer identifier). */
function isWord(s: string, i: number, w: string): boolean {
  return s.startsWith(w, i) && !WORD_CHAR.test(s[i + w.length] ?? "") && (i === 0 || !WORD_CHAR.test(s[i - 1]!));
}

const TYPE_PREFIXES = ["readonly", "keyof", "typeof", "unique", "infer"];

/** One member of a union or intersection type at `i`: its end, or -1 when there is no type there. */
function readTypeMember(s: string, i: number): number {
  i = ws(s, i);
  for (;;) {
    const w = TYPE_PREFIXES.find((p) => isWord(s, i, p) && /\s/.test(s[i + p.length] ?? ""));
    if (!w) break;
    i = ws(s, i + w.length);
  }
  let end = -1;
  const c = s[i];
  if (c === undefined) return -1;
  if (isWord(s, i, "new")) return readTypeMember(s, i + 3);
  if (c === "<") {
    // A generic function type: <T>(a: T) => T.
    const e = pair(s, i);
    if (e < 0) return -1;
    return readTypeMember(s, e);
  }
  if (c === "(") {
    const e = pair(s, i);
    if (e < 0) return -1;
    const j = ws(s, e);
    if (s.startsWith("=>", j)) return readType(s, j + 2);
    end = e;
  } else if (c === "{" || c === "[") {
    end = pair(s, i);
  } else if (c === '"' || c === "'" || c === "`") {
    end = skipString(s, i);
  } else if (/[-\d]/.test(c)) {
    const m = /^-?\d[\d_]*(?:\.\d+)?/.exec(s.slice(i, i + 60));
    end = m ? i + m[0].length : -1;
  } else {
    const m = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(s.slice(i, i + 300));
    if (!m) return -1;
    end = i + m[0].length;
    if (s[end] === "<") {
      const e = pair(s, end);
      if (e > 0) end = e;
    }
    // A type predicate: `x is T` (and `asserts x is T`, whose prefix reads as an identifier).
    const after = ws(s, end);
    if (isWord(s, after, "is") && m[0] !== "is") {
      const t = readType(s, after + 2);
      if (t > 0) return t;
    }
    if (m[0] === "asserts" && /\s/.test(s[end] ?? "")) {
      const t = readTypeMember(s, end);
      if (t > 0) return t;
    }
  }
  if (end < 0) return -1;
  // Array and indexed access suffixes: Money[], T["key"].
  while (s[end] === "[") {
    const e = pair(s, end);
    if (e < 0) break;
    end = e;
  }
  return end;
}

/** The end of the type that starts at `i` (a union or intersection of members, a leading "|" allowed), or -1 when there is none. */
export function readType(s: string, i: number): number {
  i = ws(s, i);
  if ((s[i] === "|" || s[i] === "&") && s[i + 1] !== s[i]) i = ws(s, i + 1);
  let end = readTypeMember(s, i);
  if (end < 0) return -1;
  for (;;) {
    const j = ws(s, end);
    const op = s[j];
    if ((op === "|" || op === "&") && s[j + 1] !== op) {
      const e = readTypeMember(s, j + 1);
      if (e < 0) break;
      end = e;
      continue;
    }
    break;
  }
  return end;
}

/** `text` split at commas outside brackets and strings. */
function splitTop(text: string, seps = ","): string[] {
  const out: string[] = [];
  let start = 0;
  for (let j = 0; j < text.length; j++) {
    const ch = text[j]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const e = skipString(text, j);
      if (e < 0) break;
      j = e - 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") {
      const e = pair(text, j);
      if (e > 0) {
        j = e - 1;
        continue;
      }
      if (ch !== "<") break;
      continue;
    }
    if (seps.includes(ch)) {
      out.push(text.slice(start, j));
      start = j + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/** The primitive type a literal default value gives an unannotated parameter, or null. */
function literalType(value: string): string | null {
  const v = value.trim();
  if (v === "true" || v === "false") return "boolean";
  if (/^-?\d[\d_]*(?:\.\d+)?$/.test(v)) return "number";
  if (/^(["'])(?:\\.|(?!\1).)*\1$/.test(v) || /^`[^`$]*`$/.test(v)) return "string";
  return null;
}

/** The parameters of a parameter list's inside, as written. A `this` parameter (not an argument) is left out. */
export function parseParams(inside: string): TsParam[] | null {
  if (inside.trim() === "") return [];
  const out: TsParam[] = [];
  for (const raw of splitTop(inside)) {
    const text = raw.trim().replace(/\s+/g, " ");
    if (text === "") {
      // A trailing comma.
      continue;
    }
    let i = 0;
    const rest = text.startsWith("...");
    if (rest) i = 3;
    if (text[i] === "{" || text[i] === "[") {
      const e = pair(text, i);
      if (e < 0) return null;
      i = e;
    } else {
      const name = wordAt(text, i);
      if (!name) return null;
      if (name === "this" && !rest) continue;
      i += name.length;
    }
    i = ws(text, i);
    let optional = false;
    if (text[i] === "?") {
      optional = true;
      i = ws(text, i + 1);
    }
    let type: string | null = null;
    if (text[i] === ":") {
      const start = ws(text, i + 1);
      const end = readType(text, start);
      if (end < 0) return null;
      type = text.slice(start, end).trim();
      i = ws(text, end);
    }
    if (text[i] === "=" && text[i + 1] !== ">") {
      optional = true;
      if (type === null) type = literalType(text.slice(i + 1));
      i = text.length;
    }
    if (i < text.length) return null;
    out.push({ text, rest, optional, type });
  }
  return out;
}

/** The members of an interface or object type's inside (between its braces); null when one cannot be read. */
export function parseMembers(inside: string): TsMember[] | null {
  const out: TsMember[] = [];
  // Members end at ";" or "," outside brackets, or at the end of a line.
  const parts = splitTop(inside.replace(/\r/g, ""), ";,\n");
  for (const raw of parts) {
    const text = raw.trim().replace(/\s+/g, " ");
    if (text === "") continue;
    let i = 0;
    if (isWord(text, 0, "readonly") && /\s/.test(text[8] ?? "")) i = ws(text, 8);
    let name: string;
    if (text[i] === '"' || text[i] === "'") {
      const e = skipString(text, i);
      if (e < 0) return null;
      name = text.slice(i + 1, e - 1);
      i = e;
    } else if (text[i] === "[" || text[i] === "(") {
      // An index or call signature: kept whole as its name.
      return null;
    } else {
      name = wordAt(text, i);
      if (!name) return null;
      i += name.length;
    }
    i = ws(text, i);
    let optional = false;
    if (text[i] === "?") {
      optional = true;
      i = ws(text, i + 1);
    }
    let type: string | null = null;
    if (text[i] === "(" || text[i] === "<") {
      // A method: its type as a function type.
      let p = i;
      let generics = "";
      if (text[p] === "<") {
        const g = pair(text, p);
        if (g < 0) return null;
        generics = text.slice(p, g);
        p = ws(text, g);
      }
      const e = pair(text, p);
      if (e < 0) return null;
      let j = ws(text, e);
      let returns = "void";
      if (text[j] === ":") {
        const s = ws(text, j + 1);
        const t = readType(text, s);
        if (t < 0) return null;
        returns = text.slice(s, t);
        j = ws(text, t);
      }
      if (j < text.length) return null;
      type = `${generics}${text.slice(p, e)} => ${returns}`;
    } else if (text[i] === ":") {
      const s = ws(text, i + 1);
      const t = readType(text, s);
      if (t < 0 || ws(text, t) < text.length) return null;
      type = text.slice(s, t);
    } else if (i < text.length) return null;
    out.push({ name, optional, type });
  }
  return out;
}

/** A signature on one line: `name<T>(a: A, b?: B): R`. */
function signatureText(name: string, typeParams: string, params: string, returns: string | null): string {
  return `${name}${typeParams}(${params.replace(/\s+/g, " ").trim()})${returns ? `: ${returns.replace(/\s+/g, " ").trim()}` : ""}`.slice(0, 400);
}

/** A function type's signature (`(a: A) => R`, or `<T>(a: T) => T`), or null when `type` is not one. */
function functionTypeSignature(name: string, type: string): TsSignature | null {
  let i = ws(type, 0);
  let typeParams = "";
  if (type[i] === "<") {
    const e = pair(type, i);
    if (e < 0) return null;
    typeParams = type.slice(i, e);
    i = ws(type, e);
  }
  if (type[i] !== "(") return null;
  const e = pair(type, i);
  if (e < 0) return null;
  const j = ws(type, e);
  if (!type.startsWith("=>", j)) return null;
  const params = parseParams(type.slice(i + 1, e - 1));
  if (!params) return null;
  const returns = type.slice(j + 2).trim() || null;
  return { typeParams, params, returns, text: signatureText(name, typeParams, type.slice(i + 1, e - 1), returns) };
}

/** Characters that carry an expression on to the next line. */
const CONTINUES = /[.?:+\-*/|&,=<>([{`!%^~]/;

/** The end of an initializer or statement starting at `i`: a ";" or "," outside brackets, or a line end that ends it. */
function statementEnd(mask: string, i: number, commas = true): number {
  let last = "";
  for (let j = i; j < mask.length; j++) {
    const ch = mask[j]!;
    if (ch === "(" || ch === "[" || ch === "{") {
      const e = pair(mask, j, false);
      if (e < 0) return mask.length;
      j = e - 1;
      last = mask[j]!;
      continue;
    }
    // Type arguments (new Map<string, number>()): their commas do not end a declarator.
    if (ch === "<") {
      const e = pair(mask, j, false);
      if (e > 0 && !mask.slice(j, e).includes("\n")) {
        j = e - 1;
        last = ">";
        continue;
      }
    }
    if (ch === ";" || (commas && ch === ",")) return j;
    if (ch === "\n") {
      const next = mask[ws(mask, j)] ?? "";
      if (last !== "" && !CONTINUES.test(last) && !CONTINUES.test(next) && !/^\s*(?:as|satisfies|instanceof|in)\b/.test(mask.slice(j, j + 40))) return j;
      continue;
    }
    if (!/\s/.test(ch)) last = ch;
  }
  return mask.length;
}

/** A function or arrow expression's signature at `i` (to `end`), or null when the initializer is not one. */
function expressionSignature(name: string, clean: string, i: number, end: number): TsSignature | null {
  const s = clean.slice(0, end);
  i = ws(s, i);
  if (isWord(s, i, "async")) i = ws(s, i + 5);
  if (isWord(s, i, "function")) {
    i = ws(s, i + 8);
    if (s[i] === "*") i = ws(s, i + 1);
    const own = wordAt(s, i);
    i = ws(s, i + own.length);
  }
  let typeParams = "";
  if (s[i] === "<") {
    const e = pair(s, i);
    if (e < 0) return null;
    typeParams = s.slice(i, e);
    i = ws(s, e);
  }
  let inside: string;
  let j: number;
  if (s[i] === "(") {
    const e = pair(s, i);
    if (e < 0) return null;
    inside = s.slice(i + 1, e - 1);
    j = ws(s, e);
  } else {
    // A single parameter without parentheses: x => ...
    const one = wordAt(s, i);
    if (!one) return null;
    j = ws(s, i + one.length);
    if (!s.startsWith("=>", j)) return null;
    const params = [{ text: one, rest: false, optional: false, type: null }];
    return { typeParams: "", params, returns: null, text: signatureText(name, "", one, null) };
  }
  let returns: string | null = null;
  if (s[j] === ":") {
    const start = ws(s, j + 1);
    const t = readType(s, start);
    if (t < 0) return null;
    returns = s.slice(start, t).trim();
    j = ws(s, t);
  }
  if (!s.startsWith("=>", j) && s[j] !== "{") return null;
  const params = parseParams(inside);
  if (!params) return null;
  return { typeParams, params, returns, text: signatureText(name, typeParams, inside, returns) };
}

/** Is the word at `i` the first thing of a statement: at the start of a line, or after a ";" or "}"? */
function statementStart(mask: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && (mask[j] === " " || mask[j] === "\t" || mask[j] === "\r")) j--;
  return j < 0 || mask[j] === "\n" || mask[j] === ";" || mask[j] === "}";
}

/** Add a declaration under its name. */
function put(map: Map<string, TsDecl[]>, d: TsDecl): void {
  const list = map.get(d.name) ?? [];
  list.push(d);
  map.set(d.name, list);
}

/** A declaration with nothing but its name and kind. */
function bare(name: string, kind: TsDeclKind): TsDecl {
  return { name, kind, signatures: [], type: null, value: null, members: null };
}

/** File extensions the reader reads. */
const SOURCE = /\.(?:[cm]?ts|[cm]?js)$/;

/** Is this a file the reader reads (TypeScript or JavaScript, not JSX, whose text it cannot scan)? */
export function readableSource(path: string): boolean {
  return SOURCE.test(path);
}

/**
 * The top-level declarations of a module, and which names it exports (see the module comment). Overloads of a function
 * are one declaration with several signatures; `export { a as b }` exports b with a's declarations; a declaration the
 * reader cannot follow makes the module incomplete rather than wrong.
 */
export function readModule(text: string): TsModule {
  const { clean, mask, ok } = scanSource(text);
  const local = new Map<string, TsDecl[]>();
  const exported = new Map<string, TsDecl[]>();
  const aliases: Array<{ name: string; as: string }> = [];
  let imported: Set<string> | null = new Set<string>();
  let complete = ok;
  if (/\bmodule\.exports\b|(?:^|[^.\w$])exports\.[A-Za-z_$][\w$]*\s*=/.test(clean)) complete = false;
  const n = mask.length;
  let i = 0;
  while (i < n) {
    const ch = mask[i]!;
    if (ch === "(" || ch === "[" || ch === "{") {
      const e = pair(mask, i, false);
      if (e < 0) {
        complete = false;
        break;
      }
      i = e;
      continue;
    }
    if (!WORD_CHAR.test(ch) || (i > 0 && WORD_CHAR.test(mask[i - 1]!))) {
      i++;
      continue;
    }
    const w = wordAt(mask, i);
    if (!w || !statementStart(mask, i)) {
      i += Math.max(1, w.length);
      continue;
    }
    if (w === "import") {
      const r = importDecl(clean, mask, i);
      if (r.names && imported) for (const name of r.names) imported.add(name);
      else if (!r.names) imported = null;
      i = Math.max(r.end, i + w.length);
      continue;
    }
    const r = declaration(clean, mask, i);
    if (!r) {
      i += w.length;
      continue;
    }
    if (r.incomplete) complete = false;
    for (const d of r.decls) {
      if (d.kind === "function") {
        // Overloads and the implementation: one declaration with every signature.
        const same = (local.get(d.name) ?? []).find((x) => x.kind === "function");
        if (same) {
          same.signatures.push(...d.signatures);
          if (r.exported && !(exported.get(d.name) ?? []).includes(same)) put(exported, same);
          continue;
        }
      }
      if (d.kind !== "reexport") put(local, d);
      if (r.exported) put(exported, d);
    }
    aliases.push(...r.aliases);
    i = Math.max(r.end, i + w.length);
  }
  for (const a of aliases) {
    const decls = local.get(a.name);
    // A name the module imports and exports again: exported, with nothing known of it here.
    if (decls) for (const d of decls) put(exported, { ...d, name: a.as });
    else put(exported, bare(a.as, "reexport"));
  }
  return { local, exported, complete, imported: ok ? imported : null, clean };
}

/** The names an import statement at `i` binds (null when it cannot be read), and where it ends. */
function importDecl(clean: string, mask: string, i: number): { names: string[] | null; end: number } {
  let j = ws(mask, i + 6);
  // A dynamic import or import.meta is an expression, not a declaration.
  if (mask[j] === "(" || mask[j] === ".") return { names: [], end: j };
  const end = statementEnd(mask, j, false);
  // A side-effect import: import "./x.ts".
  if (mask[j] === "\"" || mask[j] === "'") return { names: [], end };
  if (isWord(mask, j, "type") && !/^type\s*(?:,|from\b|=)/.test(mask.slice(j, j + 40))) j = ws(mask, j + 4);
  const from = mask.slice(j, end).search(/\bfrom\b|=/);
  if (from < 0) return { names: null, end };
  const clause = clean.slice(j, j + from).trim();
  const names: string[] = [];
  const braces = /\{([^}]*)\}/.exec(clause);
  if (braces) {
    for (const part of braces[1]!.split(",")) {
      const m = /^(?:type\s+)?([A-Za-z_$][\w$]*|default)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/.exec(part.trim());
      if (part.trim() === "") continue;
      if (!m) return { names: null, end };
      names.push(m[2] ?? m[1]!);
    }
  }
  for (const part of clause.replace(/\{[^}]*\}/, "").split(",")) {
    const p = part.trim();
    if (p === "") continue;
    const m = /^(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)$/.exec(p);
    if (!m) return { names: null, end };
    names.push(m[1]!);
  }
  return { names, end };
}

/** What one top-level statement declares. */
interface Declared {
  decls: TsDecl[];
  exported: boolean;
  /** `export { a as b }` without a source: names resolved against the module's own declarations. */
  aliases: Array<{ name: string; as: string }>;
  incomplete?: boolean;
  end: number;
}

/** The declaration starting at `i` (a statement start), or null when it is not one. */
function declaration(clean: string, mask: string, start: number): Declared | null {
  let i = start;
  let exported = false;
  const out: Declared = { decls: [], exported: false, aliases: [], end: start };
  if (isWord(mask, i, "export")) {
    exported = true;
    i = ws(mask, i + 6);
    if (mask[i] === "*") {
      // export * from "x" (every name unknown here), or export * as ns from "x".
      const j = ws(mask, i + 1);
      const end = statementEnd(mask, i, false);
      if (isWord(mask, j, "as")) {
        const ns = wordAt(mask, ws(mask, j + 2));
        if (ns) return { decls: [bare(ns, "reexport")], exported, aliases: [], end };
      }
      return { decls: [], exported, aliases: [], incomplete: true, end };
    }
    if (mask[i] === "=") return { decls: [], exported, aliases: [], incomplete: true, end: statementEnd(mask, i, false) };
    if (mask[i] === "{") return exportList(clean, mask, i);
    if (isWord(mask, i, "type") && mask[ws(mask, i + 4)] === "{") return exportList(clean, mask, ws(mask, i + 4));
    if (isWord(mask, i, "default")) {
      // Not a named export: skipped, its own declaration read as a local one when it has a name.
      const j = ws(mask, i + 7);
      const inner = declaration(clean, mask, j);
      return { decls: inner ? inner.decls : [], exported: false, aliases: [], end: inner ? inner.end : statementEnd(mask, j, false) };
    }
    if (isWord(mask, i, "as")) return { decls: [], exported: false, aliases: [], end: statementEnd(mask, i, false) };
    if (isWord(mask, i, "import")) {
      const name = wordAt(mask, ws(mask, i + 6));
      return name ? { decls: [bare(name, "other")], exported, aliases: [], end: statementEnd(mask, i, false) } : null;
    }
  }
  out.exported = exported;
  for (const mod of ["declare", "abstract", "async"]) {
    if (isWord(mask, i, mod)) i = ws(mask, i + mod.length);
  }
  if (isWord(mask, i, "function")) return withExport(functionDecl(clean, mask, i), exported);
  if (isWord(mask, i, "const") && isWord(mask, ws(mask, i + 5), "enum")) return withExport(blockDecl(clean, mask, ws(mask, i + 5), "enum"), exported);
  for (const kw of ["const", "let", "var"]) if (isWord(mask, i, kw)) return withExport(variableDecl(clean, mask, i + kw.length), exported);
  if (isWord(mask, i, "interface")) return withExport(interfaceDecl(clean, mask, i), exported);
  if (isWord(mask, i, "type")) {
    const r = typeDecl(clean, mask, i);
    return r ? withExport(r, exported) : exported ? { ...out, incomplete: true, end: statementEnd(mask, i, false) } : null;
  }
  if (isWord(mask, i, "class")) return withExport(blockDecl(clean, mask, i, "class"), exported);
  if (isWord(mask, i, "enum")) return withExport(blockDecl(clean, mask, i, "enum"), exported);
  if (isWord(mask, i, "namespace") || isWord(mask, i, "module")) return withExport(blockDecl(clean, mask, i, "namespace"), exported);
  // An export the reader does not know: its names are unknown.
  return exported ? { ...out, incomplete: true, end: statementEnd(mask, i, false) } : null;
}

/** A declaration result marked exported or not; a failed one of an export leaves the module incomplete. */
function withExport(r: Declared | null, exported: boolean): Declared | null {
  if (!r) return null;
  return { ...r, exported, ...(exported && r.incomplete ? { incomplete: true } : {}) };
}

/** `export { a, b as c } [from "x"]` at the "{" at `i`. */
function exportList(clean: string, mask: string, i: number): Declared {
  const e = pair(mask, i, false);
  if (e < 0) return { decls: [], exported: true, aliases: [], incomplete: true, end: mask.length };
  const names = splitTop(clean.slice(i + 1, e - 1))
    .map((x) => x.trim().replace(/^type\s+/, ""))
    .filter(Boolean);
  const j = ws(mask, e);
  const from = isWord(mask, j, "from");
  const end = statementEnd(mask, from ? j : e, false);
  const decls: TsDecl[] = [];
  const aliases: Array<{ name: string; as: string }> = [];
  let incomplete = false;
  for (const x of names) {
    const m = /^([A-Za-z_$][\w$]*|default)(?:\s+as\s+([A-Za-z_$][\w$]*|default))?$/.exec(x);
    if (!m) {
      incomplete = true;
      continue;
    }
    const as = m[2] ?? m[1]!;
    if (from) decls.push(bare(as, "reexport"));
    else aliases.push({ name: m[1]!, as });
  }
  return { decls, exported: true, aliases, ...(incomplete ? { incomplete } : {}), end };
}

/** `function name<T>(params): R { … }` (or an overload ending in ";") at `i`. */
function functionDecl(clean: string, mask: string, i: number): Declared | null {
  let j = ws(mask, i + 8);
  if (mask[j] === "*") j = ws(mask, j + 1);
  const name = wordAt(mask, j);
  if (!name) return null;
  j = ws(mask, j + name.length);
  let typeParams = "";
  if (mask[j] === "<") {
    const e = pair(clean, j);
    if (e < 0) return { decls: [bare(name, "function")], exported: false, aliases: [], incomplete: true, end: statementEnd(mask, j, false) };
    typeParams = clean.slice(j, e);
    j = ws(mask, e);
  }
  if (mask[j] !== "(") return { decls: [bare(name, "function")], exported: false, aliases: [], incomplete: true, end: statementEnd(mask, j, false) };
  const close = pair(mask, j, false);
  if (close < 0) return { decls: [bare(name, "function")], exported: false, aliases: [], incomplete: true, end: mask.length };
  const inside = clean.slice(j + 1, close - 1);
  let k = ws(mask, close);
  let returns: string | null = null;
  let readable = true;
  if (mask[k] === ":") {
    const s = ws(clean, k + 1);
    const t = readType(clean, s);
    if (t < 0) readable = false;
    else {
      returns = clean.slice(s, t).trim();
      k = ws(mask, t);
    }
  }
  // The body, or the end of an overload.
  let end: number;
  if (mask[k] === "{") {
    const e = pair(mask, k, false);
    end = e < 0 ? mask.length : e;
  } else if (mask[k] === ";" || mask[k] === undefined) {
    end = k + 1;
  } else {
    // A return type the reader cannot follow: the signature is kept without it, and the body found ahead.
    readable = false;
    const body = mask.indexOf("{", k);
    const e = body < 0 ? -1 : pair(mask, body, false);
    end = e < 0 ? statementEnd(mask, k, false) : e;
  }
  const params = parseParams(inside);
  const decl = bare(name, "function");
  if (params && readable) decl.signatures.push({ typeParams, params, returns, text: signatureText(name, typeParams, inside, returns) });
  else if (params) decl.signatures.push({ typeParams, params, returns: "?", text: signatureText(name, typeParams, inside, null) });
  return { decls: [decl], exported: false, aliases: [], ...(params ? {} : { incomplete: true }), end };
}

/** `const name: T = value` (several declarators allowed) after the keyword, ending at `i`. */
function variableDecl(clean: string, mask: string, i: number): Declared | null {
  const decls: TsDecl[] = [];
  let j = ws(mask, i);
  for (;;) {
    if (mask[j] === "{" || mask[j] === "[") {
      // Destructuring: the names it declares are not read.
      return { decls, exported: false, aliases: [], incomplete: true, end: statementEnd(mask, j, false) };
    }
    const name = wordAt(mask, j);
    if (!name) return decls.length > 0 ? { decls, exported: false, aliases: [], incomplete: true, end: statementEnd(mask, j, false) } : null;
    j = ws(mask, j + name.length);
    if (mask[j] === "!") j = ws(mask, j + 1);
    const decl = bare(name, "const");
    if (mask[j] === ":") {
      const s = ws(clean, j + 1);
      const t = readType(clean, s);
      if (t < 0) return { decls: [...decls, decl], exported: false, aliases: [], incomplete: true, end: statementEnd(mask, j, false) };
      decl.type = clean.slice(s, t).trim();
      j = ws(mask, t);
    }
    if (mask[j] === "=" && mask[j + 1] !== "=") {
      const s = ws(mask, j + 1);
      const e = statementEnd(mask, s);
      decl.value = clean.slice(s, e).trim();
      const sig = expressionSignature(name, clean, s, e);
      if (sig) decl.signatures.push(sig);
      j = e;
    }
    if (decl.signatures.length === 0 && decl.type) {
      const sig = functionTypeSignature(name, decl.type);
      if (sig) decl.signatures.push(sig);
    }
    decls.push(decl);
    if (mask[j] === ",") {
      j = ws(mask, j + 1);
      continue;
    }
    return { decls, exported: false, aliases: [], end: j < mask.length && mask[j] === ";" ? j + 1 : j };
  }
}

/** `interface Name<T> extends A { members }` at `i`. */
function interfaceDecl(clean: string, mask: string, i: number): Declared | null {
  let j = ws(mask, i + 9);
  const name = wordAt(mask, j);
  if (!name) return null;
  j = ws(mask, j + name.length);
  const decl = bare(name, "interface");
  const open = mask.indexOf("{", j);
  if (open < 0) return { decls: [decl], exported: false, aliases: [], incomplete: true, end: mask.length };
  if (/\bextends\b/.test(mask.slice(j, open))) decl.inherits = true;
  const close = pair(mask, open, false);
  if (close < 0) return { decls: [decl], exported: false, aliases: [], incomplete: true, end: mask.length };
  decl.members = parseMembers(clean.slice(open + 1, close - 1));
  return { decls: [decl], exported: false, aliases: [], end: close };
}

/** `type Name<T> = T` at `i`; null when the words there are not a type alias. */
function typeDecl(clean: string, mask: string, i: number): Declared | null {
  let j = ws(mask, i + 4);
  const name = wordAt(mask, j);
  if (!name) return null;
  j = ws(mask, j + name.length);
  if (mask[j] === "<") {
    const e = pair(clean, j);
    if (e < 0) return null;
    j = ws(mask, e);
  }
  if (mask[j] !== "=" || mask[j + 1] === "=") return null;
  const s = ws(clean, j + 1);
  const t = readType(clean, s);
  const decl = bare(name, "type");
  if (t < 0) return { decls: [decl], exported: false, aliases: [], incomplete: true, end: statementEnd(mask, s, false) };
  decl.type = clean.slice(s, t).trim().replace(/^[|&]\s*/, "");
  if (decl.type.startsWith("{") && decl.type.endsWith("}")) decl.members = parseMembers(decl.type.slice(1, -1));
  let end = ws(mask, t);
  if (mask[end] === ";") end++;
  return { decls: [decl], exported: false, aliases: [], end };
}

/** A class, enum or namespace at `i`: its name, its body skipped. */
function blockDecl(clean: string, mask: string, i: number, kind: "class" | "enum" | "namespace"): Declared | null {
  const kw = wordAt(mask, i);
  let j = ws(mask, i + kw.length);
  if (kind === "class" && isWord(mask, j, "abstract")) j = ws(mask, j + 8);
  const name = mask[j] === '"' || mask[j] === "'" ? "" : wordAt(mask, j);
  const open = mask.indexOf("{", j);
  const close = open < 0 ? -1 : pair(mask, open, false);
  const end = close < 0 ? mask.length : close;
  if (!name) return { decls: [], exported: false, aliases: [], end };
  return { decls: [bare(name, kind)], exported: false, aliases: [], ...(close < 0 ? { incomplete: true } : {}), end };
}

// ---------------------------------------------------------------------------------------------------------------------
// Types as text
// ---------------------------------------------------------------------------------------------------------------------

/** Primitive type words, and the words that may join them in a type that names nothing else. */
const PRIMITIVES: ReadonlySet<string> = new Set(["string", "number", "boolean", "bigint", "symbol", "void", "undefined", "null", "never", "unknown", "any", "object", "true", "false", "readonly"]);

/** The parts of a type's text outside string literals, and the literals, in order (a literal starts with its quote). */
function segments(t: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let j = 0; j < t.length; j++) {
    const ch = t[j]!;
    if (ch !== '"' && ch !== "'" && ch !== "`") continue;
    const e = skipString(t, j);
    if (e < 0) break;
    out.push(t.slice(start, j), t.slice(j, e));
    start = e;
    j = e - 1;
  }
  out.push(t.slice(start));
  return out;
}

/** A string literal with double quotes. */
function doubleQuoted(lit: string): string {
  if (lit.startsWith('"')) return lit;
  const body = lit.slice(1, -1);
  return JSON.stringify(body.replace(/\\(['`])/g, "$1"));
}

/** Top-level parts of a normalized type split at `sep` ("|" or "&"), outside brackets and strings. */
function topSplit(t: string, sep: string): string[] {
  return splitTop(t, sep).map((x) => x.trim());
}

/**
 * A type's text in one form, so equal types written differently compare equal: white space only where words meet, string
 * literals in double quotes, members of an object type separated by ";" with no trailing one, Array<T> and
 * ReadonlyArray<T> of a simple T written T[] and readonly T[], and the members of a top-level union sorted (true | false
 * written boolean).
 */
export function normalizeType(type: string): string {
  let t = segments(type.trim())
    .map((s, i) => (i % 2 === 1 ? doubleQuoted(s) : s.replace(/\s+/g, " ").replace(/\s*([{}[\]()<>,;:|&?=!.])\s*/g, "$1")))
    .join("");
  t = t.replace(/^[|&]/, "");
  // Array<T> and ReadonlyArray<T> of a word.
  t = t.replace(/\bReadonlyArray<([A-Za-z_$][\w$.]*)>/g, "readonly $1[]").replace(/\bArray<([A-Za-z_$][\w$.]*)>/g, "$1[]");
  // Object types: ";" between members, none before the closing brace.
  let out = "";
  const stack: string[] = [];
  for (let j = 0; j < t.length; j++) {
    const ch = t[j]!;
    if (ch === '"') {
      const e = skipString(t, j);
      const lit = e < 0 ? t.slice(j) : t.slice(j, e);
      out += lit;
      j += lit.length - 1;
      continue;
    }
    if (ch === "{" || ch === "(" || ch === "[" || ch === "<") stack.push(ch);
    else if (ch === "}" || ch === ")" || ch === "]" || (ch === ">" && t[j - 1] !== "=")) stack.pop();
    if ((ch === ";" || ch === ",") && t[j + 1] === "}" && stack[stack.length - 1] === "{") continue;
    if (ch === "," && stack[stack.length - 1] === "{") {
      out += ";";
      continue;
    }
    out += ch;
  }
  let union = topSplit(out, "|");
  // true | false is boolean.
  if (union.includes("true") && union.includes("false")) union = [...union.filter((u) => u !== "true" && u !== "false"), "boolean"];
  return union.length > 1 ? [...new Set(union)].sort().join("|") : union[0]!;
}

/** Does a normalized type name nothing but primitives and literals (string, number | null, "a" | "b", readonly boolean[])? */
function primitiveOnly(t: string): boolean {
  const words = segments(t).flatMap((s, i) => (i % 2 === 1 ? [] : s.split(/[|&()[\]\s]+/).filter(Boolean)));
  if (/[{}<>:=,;]/.test(segments(t).filter((_, i) => i % 2 === 0).join(""))) return false;
  return words.every((w) => PRIMITIVES.has(w) || /^-?\d[\d_]*(?:\.\d+)?$/.test(w));
}

/** Global type names that stand for primitive types: never sure to differ from one. */
const PRIMITIVE_ALIASES: ReadonlySet<string> = new Set(["PropertyKey"]);

/**
 * Can sameType be sure two different types differ? A primitive type; a word the module declares as an interface, class or
 * enum; or a word it neither declares nor imports (so it cannot stand for another type there), when its imports were read.
 */
function definite(t: string, mod: TsModule): boolean {
  if (primitiveOnly(t)) return true;
  const m = /^(?:readonly )?([A-Za-z_$][\w$]*)(?:\[\])*$/.exec(t);
  if (!m) return false;
  const name = m[1]!;
  const decls = mod.local.get(name) ?? [];
  if (decls.length > 0) return decls.every((d) => d.kind === "interface" || d.kind === "class" || d.kind === "enum");
  return mod.imported !== null && !mod.imported.has(name) && !PRIMITIVE_ALIASES.has(name);
}

/** A word the module declares as a type alias, followed once: its aliased type, normalized. */
function unalias(t: string, mod: TsModule): string | null {
  if (!/^[A-Za-z_$][\w$]*$/.test(t)) return null;
  const alias = (mod.local.get(t) ?? []).find((d) => d.kind === "type" && d.type !== null);
  return alias?.type ? normalizeType(alias.type) : null;
}

/** How two types compare: the same, different (sure), or unknown. */
export type TypeMatch = "same" | "differs" | "unknown";

/**
 * Compare a type a line states (`want`) with the one a module declares (`got`): the same when they normalize alike
 * (type aliases the module declares followed), different when both are plain enough to be sure (primitives, literals,
 * or names of the module's own interfaces, classes and enums), unknown otherwise.
 */
export function sameType(want: string, got: string, mod: TsModule): TypeMatch {
  let a = normalizeType(want);
  let b = normalizeType(got);
  for (let k = 0; k < 4 && a !== b; k++) {
    const ua = unalias(a, mod);
    const ub = unalias(b, mod);
    if (!ua && !ub) break;
    a = ua ?? a;
    b = ub ?? b;
  }
  if (a === b) return "same";
  return definite(a, mod) && definite(b, mod) ? "differs" : "unknown";
}
