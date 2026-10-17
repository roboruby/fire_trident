import type { Path } from "./types.ts";
import { lineDiff } from "./textmerge.ts";

/**
 * The token comparison `why` uses to walk one line back through the landings (worker trunk/whywalk.ts): whether a landing
 * only reformatted the line, and whether the line came in a block moved from another file. Deterministic, no model.
 *
 * JavaScript, TypeScript and JSON files are compared as tokens: whitespace and line breaks are ignored, a string's
 * quote style is normalized (' and " read the same), and the commas and semicolons a formatter adds or drops are left
 * out (a comma before a closing bracket, and a semicolon outside parentheses, which ends a statement the language can
 * infer). So a landing that changed only whitespace, quote style, trailing commas or semicolons, or the line wrapping of
 * the same tokens, reformatted the line. Other files are compared line by line, exactly: nothing in them is formatting.
 */

/** Token edits one comparison computes at most; a larger rewrite counts as a change of meaning. */
export const REFORMAT_MAX_EDITS = 1_000;
/** Lines a moved block holds at least (in the file it moved to). */
export const MOVE_MIN_LINES = 3;
/** Words (identifiers, numbers, strings, comment words) a moved block holds at least, so a run of closing brackets is no block. */
export const MOVE_MIN_WORDS = 3;
/** Token comparisons one move search makes at most. */
const MOVE_MAX_WORK = 2_000_000;

/** One token: its normalized text, and the line (0-based, as "\n" splits the text) where it starts. */
export interface CodeToken {
  key: string;
  line: number;
}

/** A file the comparison reads as JavaScript, TypeScript or JSON tokens (by its extension). */
export function tokenAware(path: Path): boolean {
  return /\.(?:[cm]?[jt]sx?|json5?|jsonc)$/i.test(path);
}

/** Operators of more than one character, longest first, so `===` is one token and not three. */
const OPERATORS = [">>>=", "...", "===", "!==", "**=", "<<=", ">>=", ">>>", "&&=", "||=", "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "?.", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>"];
const WORD = /[A-Za-z0-9_$\u0080-￿]/;
const CLOSERS = new Set([")", "]", "}", ">"]);

/**
 * The tokens of a JavaScript, TypeScript or JSON text, normalized for comparison (see the module comment). A string is one
 * token whatever its quotes; a template literal one token as written; a comment its words, after a marker. Regular
 * expressions are not told from division: both versions of a file read the same way, which is all a comparison needs.
 */
export function codeTokens(text: string): CodeToken[] {
  const raw: CodeToken[] = [];
  let line = 0;
  let i = 0;
  const n = text.length;
  const words = (body: string, from: number, prefix: string): void => {
    let at = from;
    for (const part of body.split("\n")) {
      for (const w of part.split(/\s+/)) if (w !== "") raw.push({ key: `${prefix}${w}`, line: at });
      at++;
    }
  };
  while (i < n) {
    const ch = text[i]!;
    if (ch === "\n") {
      line++;
      i++;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      raw.push({ key: "//", line });
      words(text.slice(i + 2, stop), line, "c:");
      i = stop;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end;
      const body = text.slice(i + 2, stop);
      raw.push({ key: "/*", line });
      words(body, line, "c:");
      line += countLines(body);
      raw.push({ key: "*/", line });
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      // A string ends at its closing quote, or at the end of its line when it has none.
      const start = line;
      let j = i + 1;
      let body = "";
      while (j < n && text[j] !== ch && text[j] !== "\n") {
        if (text[j] === "\\" && j + 1 < n) {
          const next = text[j + 1]!;
          body += next === "'" || next === '"' ? next : `\\${next}`;
          if (next === "\n") line++;
          j += 2;
          continue;
        }
        body += text[j];
        j++;
      }
      raw.push({ key: `s:${body}`, line: start });
      i = j < n && text[j] === ch ? j + 1 : j;
      continue;
    }
    if (ch === "`") {
      const start = line;
      const end = templateEnd(text, i);
      const body = text.slice(i, end);
      raw.push({ key: `t:${body}`, line: start });
      line += countLines(body);
      i = end;
      continue;
    }
    if (WORD.test(ch)) {
      let j = i + 1;
      const digit = ch >= "0" && ch <= "9";
      while (j < n) {
        const c = text[j]!;
        if (WORD.test(c) || (digit && c === ".")) j++;
        else if (digit && (c === "+" || c === "-") && /[eE]/.test(text[j - 1]!) && !/^0[xX]/.test(text.slice(i, j))) j++;
        else break;
      }
      raw.push({ key: text.slice(i, j), line });
      i = j;
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i)) ?? ch;
    raw.push({ key: op, line });
    i += op.length;
  }
  return dropOptional(raw);
}

/** Where a template literal that starts at `from` ends (after its closing backtick), its `${...}` parts skipped whole. */
function templateEnd(text: string, from: number): number {
  let i = from + 1;
  let depth = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (depth === 0 && c === "`") return i + 1;
    if (c === "$" && text[i + 1] === "{") {
      depth++;
      i += 2;
      continue;
    }
    if (depth > 0 && c === "}") depth--;
    else if (depth > 0 && c === "{") depth++;
    i++;
  }
  return text.length;
}

function countLines(s: string): number {
  let k = 0;
  for (let i = s.indexOf("\n"); i >= 0; i = s.indexOf("\n", i + 1)) k++;
  return k;
}

/** The tokens without the commas a formatter adds before a closing bracket and the semicolons that end a statement. */
function dropOptional(raw: CodeToken[]): CodeToken[] {
  const out: CodeToken[] = [];
  const open: string[] = [];
  for (let k = 0; k < raw.length; k++) {
    const t = raw[k]!;
    if (t.key === "(" || t.key === "[" || t.key === "{") open.push(t.key);
    else if ((t.key === ")" || t.key === "]" || t.key === "}") && open.length > 0) open.pop();
    if (t.key === "," && CLOSERS.has(raw[k + 1]?.key ?? "")) continue;
    if (t.key === ";" && open[open.length - 1] !== "(") continue;
    out.push(t);
  }
  return out;
}

/** The tokens of a file as the comparison reads it: code tokens for JavaScript, TypeScript and JSON, else each non-blank line whole. */
export function fileTokens(path: Path, text: string): CodeToken[] {
  if (tokenAware(path)) return codeTokens(text);
  const out: CodeToken[] = [];
  text.split("\n").forEach((l, line) => {
    const key = l.replace(/\r$/, "");
    if (key.trim() !== "") out.push({ key, line });
  });
  return out;
}

/** Token keys as numbers, equal keys equal numbers across every sequence numbered with one table. */
class Ids {
  private readonly ids = new Map<string, number>();

  of(tokens: readonly CodeToken[]): Int32Array {
    const out = new Int32Array(tokens.length);
    for (let i = 0; i < tokens.length; i++) {
      const key = tokens[i]!.key;
      let id = this.ids.get(key);
      if (id === undefined) {
        id = this.ids.size;
        this.ids.set(key, id);
      }
      out[i] = id;
    }
    return out;
  }
}

/** For each token of `b`, the token of `a` it was kept from, or -1 when `b` added it; null when the diff is too large. */
function align(a: Int32Array, b: Int32Array): Int32Array | null {
  const hunks = lineDiff(a, b, REFORMAT_MAX_EDITS);
  if (hunks === null) return null;
  const out = new Int32Array(b.length).fill(-1);
  let ai = 0;
  let bi = 0;
  for (const h of hunks) {
    while (bi < h.b0) out[bi++] = ai++;
    ai = h.a1;
    bi = h.b1;
  }
  while (bi < b.length) out[bi++] = ai++;
  return out;
}

/** The tokens [from, to) that start on `line`, or null when none does. */
function lineSpan(tokens: readonly CodeToken[], line: number): [number, number] | null {
  let from = -1;
  let to = -1;
  for (let k = 0; k < tokens.length; k++) {
    const l = tokens[k]!.line;
    if (l === line) {
      if (from < 0) from = k;
      to = k + 1;
    } else if (l > line) break;
  }
  return from < 0 ? null : [from, to];
}

/**
 * When a landing changed line `line` (0-based) of `after` from `before` only by reformatting it, the line of `before`
 * (0-based) its tokens came from (the first one's line, when a wrap joined lines); null when it changed the line's
 * meaning. A line is reformatted when every token on it is kept from `before`, in order and with nothing removed
 * between them. Only JavaScript, TypeScript and JSON files are compared; a line with no token (blank, or a semicolon) is
 * never reformatted.
 */
export function reformattedFrom(path: Path, before: string, after: string, line: number): number | null {
  if (!tokenAware(path)) return null;
  const b = codeTokens(after);
  const span = lineSpan(b, line);
  if (!span) return null;
  const a = codeTokens(before);
  const ids = new Ids();
  const kept = align(ids.of(a), ids.of(b));
  if (kept === null) return null;
  const first = kept[span[0]]!;
  if (first < 0) return null;
  for (let k = span[0]; k < span[1]; k++) if (kept[k] !== first + (k - span[0])) return null;
  return a[first]!.line;
}

/** A file another landing path changed in the same landing: its text before, and after (null: it deleted the file). */
export interface MoveSource {
  path: Path;
  before: string;
  after: string | null;
}

/** Tokens of `of` that `to` does not hold (1), against its tokens: what `of` added or removed; every token when `to` is null. */
function unmatched(path: Path, of: readonly CodeToken[], to: string | null, ids: Ids): Uint8Array | null {
  const mask = new Uint8Array(of.length).fill(1);
  if (to === null) return mask;
  const kept = align(ids.of(fileTokens(path, to)), ids.of(of));
  if (kept === null) return null;
  for (let k = 0; k < of.length; k++) if (kept[k]! >= 0) mask[k] = 0;
  return mask;
}

/**
 * When line `line` (0-based) of `after` came in a block the same landing removed from another file, that file and the
 * line (0-based, in its `before`) the line's first token came from; null otherwise. The block is the longest run of
 * tokens the landing added to this file and removed from the other one, the same after the formatting normalization,
 * holding every token of the line, at least MOVE_MIN_LINES lines of this file and MOVE_MIN_WORDS words. `before` is
 * null when the landing created the file. Sources are tried in order; the longest block wins, the first on a tie.
 */
export function movedFrom(path: Path, before: string | null, after: string, line: number, sources: readonly MoveSource[]): { path: Path; line: number } | null {
  const b = fileTokens(path, after);
  const span = lineSpan(b, line);
  if (!span) return null;
  const ids = new Ids();
  const added = unmatched(path, b, before, ids);
  if (added === null) return null;
  for (let k = span[0]; k < span[1]; k++) if (added[k] === 0) return null;
  const bIds = ids.of(b);
  // Each line's first and last token, to count the lines a block holds whole.
  const firstOf = new Map<number, number>();
  const lastOf = new Map<number, number>();
  b.forEach((t, k) => {
    if (!firstOf.has(t.line)) firstOf.set(t.line, k);
    lastOf.set(t.line, k);
  });
  let best: { path: Path; line: number; length: number } | null = null;
  let work = 0;
  for (const src of sources) {
    if (src.path === path || tokenAware(src.path) !== tokenAware(path)) continue;
    const s = fileTokens(src.path, src.before);
    const removed = unmatched(src.path, s, src.after, ids);
    if (removed === null) continue;
    const sIds = ids.of(s);
    for (let k = 0; k < s.length; k++) {
      if (removed[k] === 0 || sIds[k] !== bIds[span[0]]) continue;
      // Grow the run around the line's first token while both sides hold the same added and removed tokens.
      let lo = 0;
      while (span[0] - lo - 1 >= 0 && k - lo - 1 >= 0 && added[span[0] - lo - 1] === 1 && removed[k - lo - 1] === 1 && bIds[span[0] - lo - 1] === sIds[k - lo - 1]) lo++;
      let hi = 0;
      while (span[0] + hi < b.length && k + hi < s.length && added[span[0] + hi] === 1 && removed[k + hi] === 1 && bIds[span[0] + hi] === sIds[k + hi]) hi++;
      work += lo + hi;
      const from = span[0] - lo;
      const to = span[0] + hi;
      if (to >= span[1] && (best === null || to - from > best.length) && block(b, from, to, firstOf, lastOf)) best = { path: src.path, line: s[k]!.line, length: to - from };
      if (work > MOVE_MAX_WORK) return best && { path: best.path, line: best.line };
    }
  }
  return best && { path: best.path, line: best.line };
}

/** Whether tokens [from, to) of `b` hold at least MOVE_MIN_LINES whole lines and MOVE_MIN_WORDS words. */
function block(b: readonly CodeToken[], from: number, to: number, firstOf: Map<number, number>, lastOf: Map<number, number>): boolean {
  let lines = 0;
  let words = 0;
  for (let k = from; k < to; k++) {
    const t = b[k]!;
    if (/[A-Za-z0-9]/.test(t.key)) words++;
    if (firstOf.get(t.line) === k && (lastOf.get(t.line) ?? -1) < to && k >= from) lines++;
  }
  return lines >= MOVE_MIN_LINES && words >= MOVE_MIN_WORDS;
}
