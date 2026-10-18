/**
 * The insertion rule of text merge (FT_MERGE_INSERTIONS, core/textmerge.ts mergeText with `insertions`): two changes
 * that each only inserted lines at the same place of the base conflict under git's rules, though both insertions can
 * usually stand. The rule lands their union: trunk's lines first, then the change's lines, without the lines trunk
 * already inserted there. Pure and synchronous.
 *
 * Lines both insertions start with, or end with, land once (sharedEnds): a function one side inserted and the other
 * inserted with more before or after it is not landed twice. The rest of the change's lines count as already inserted
 * only one by one: a line that equals one of trunk's remaining lines and stands alone in both insertions
 * (standaloneLines), a whole statement or entry on one line. A closing brace, a blank line, a decorator or a line inside
 * a multi-line construct is never dropped, so two functions added at the end of one file both land whole, while an
 * import or an export line both sides added lands once. What would still land twice is refused (openingLines): when
 * both remaining insertions hold the same multi-line construct, or the same line opening one (a function or class
 * header, a block, a call whose arguments go on), there is no union, and the conflict stays as git's rules name it.
 * Imports, and exports from another module, compare with the quotes around their module made alike, so `from './a.ts'`
 * and `from "./a.ts"` are one line.
 */

/** First non-blank characters of a line that attaches to the line after it: decorators, attributes, comments, markup. */
const ATTACHED = /^(@|#|\/\/|\/\*|\*|<|\[|--)/;
/** Last characters of a line's code whose statement or expression goes on in the next line (a sentence's period too). */
const CONTINUES = /[\\=+\-*/%&|^.?:<>!~([{]$/;
/** A character of a name or a number: a line without one (a brace, a blank line) is never a statement of its own. */
const WORD = /[A-Za-z0-9_$]/;
/** An import, or an export from another module: `import { a } from './a.ts';`, `import './b.css';`, `export * from './c.ts';`. */
const IMPORT_FROM = /^\s*(?:import\b|export\b[^'"`]*\bfrom\s*['"])/;
/** A line opening a construct that names nothing of its own (`import {`, `export {`, `export default {`): many constructs open alike. */
const UNNAMED_OPENING = /^\s*(?:(?:export|import|default|type)\s+)*[^A-Za-z0-9_$]*$/;

/** Where a scan of an insertion stands between lines: open brackets, and a string or comment that goes on. */
interface ScanState {
  depth: number;
  /** An open multi-line string (a template literal or a triple-quoted string), or a block comment. */
  open: "`" | '"""' | "'''" | "/*" | null;
}

/** What one scanned line leaves: the state after it, its code without a trailing comment, and whether it is out of shape. */
interface ScannedLine {
  state: ScanState;
  code: string;
  /** It closed a bracket it had not opened, or left a one-line string open. */
  broken: boolean;
}

/** The leading whitespace of a line, in characters. */
function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** A line without its ending. */
function bare(line: string): string {
  return line.endsWith("\r\n") ? line.slice(0, -2) : line.endsWith("\n") ? line.slice(0, -1) : line;
}

/**
 * The form two inserted lines are compared in: the line without its ending, and an import or an export from another
 * module with the single quotes around its module made double, so lines differing only in that quote style are one line.
 */
function lineKey(line: string): string {
  const text = bare(line);
  return IMPORT_FROM.test(text) ? text.replace(/'([^'"\\]*)'/g, '"$1"') : text;
}

/**
 * Scan one line from `state`: brackets outside strings and comments, strings ("", '', `` and triple quotes) and comments
 * (`//`, `#` at the start or after whitespace, block comments). A one-line string still open at the end of its line
 * closes there.
 */
function scanLine(line: string, state: ScanState): ScannedLine {
  const text = bare(line);
  let { depth, open } = state;
  let quote: '"' | "'" | null = null;
  let codeEnd = text.length;
  let dipped = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (open === "/*") {
      if (text.startsWith("*/", i)) {
        open = null;
        i += 2;
      } else i++;
      continue;
    }
    if (open !== null) {
      if (c === "\\") i += 2;
      else if (text.startsWith(open, i)) {
        i += open.length;
        open = null;
      } else i++;
      continue;
    }
    if (quote !== null) {
      if (c === "\\") i += 2;
      else {
        if (c === quote) quote = null;
        i++;
      }
      continue;
    }
    if (text.startsWith('"""', i) || text.startsWith("'''", i)) {
      open = text.slice(i, i + 3) as '"""' | "'''";
      i += 3;
    } else if (c === "`") {
      open = "`";
      i++;
    } else if (c === '"' || c === "'") {
      quote = c;
      i++;
    } else if (text.startsWith("/*", i)) {
      open = "/*";
      i += 2;
    } else if (text.startsWith("//", i) || (c === "#" && (i === 0 || /\s/.test(text[i - 1]!)))) {
      codeEnd = i;
      break;
    } else {
      if (c === "(" || c === "[" || c === "{") depth++;
      else if (c === ")" || c === "]" || c === "}") {
        depth--;
        if (depth < 0) dipped = true;
      }
      i++;
    }
  }
  return { state: { depth, open }, code: text.slice(0, codeEnd), broken: dipped || quote !== null };
}

/** What one scan of an inserted block says about each line (blockShape). */
interface LineShape {
  /** It starts outside every bracket, string and comment the block opened before it. */
  top: boolean;
  /** It closed a bracket it had not opened, or left a one-line string open. */
  broken: boolean;
  /** It ends outside every bracket, string and comment too, and is not broken. */
  closed: boolean;
  /** It ends inside a bracket, string or comment the block opened (it or a line before it). */
  leavesOpen: boolean;
  /** Its code, without a trailing comment or trailing whitespace. */
  code: string;
  /** It holds a name or a number outside a trailing comment. */
  word: boolean;
  /** It starts like a decorator, an attribute, a comment or a markup tag (it attaches to the line after it). */
  attaches: boolean;
  /** Its code ends with an operator, a period or an opening bracket (its statement goes on in the next line). */
  continues: boolean;
  /** The non-blank line before it attaches to it, or its statement goes on in it. */
  joined: boolean;
  /** The non-blank line before it goes on in it (continues), as opposed to only attaching to it. */
  continued: boolean;
  /** It is as little indented as any line of the block. */
  least: boolean;
  /** The next non-blank line is indented further (it opens an indented block). */
  opensIndent: boolean;
  /** The index of the next non-blank line, or -1 when none follows. */
  next: number;
  /** A blank line. */
  blank: boolean;
}

/** One scan of an inserted block: each line's shape (LineShape). */
function blockShape(block: readonly string[]): LineShape[] {
  const indents = block.filter((l) => bare(l).trim() !== "").map(indentOf);
  const least = indents.length > 0 ? Math.min(...indents) : 0;
  let state: ScanState = { depth: 0, open: null };
  // Whether the last non-blank line attaches to the next one, or its statement goes on in it.
  let attaching = false;
  let going = false;
  // The next non-blank line after each line, from one pass back to front.
  const nextOf: number[] = new Array<number>(block.length);
  for (let i = block.length - 1, after = -1; i >= 0; i--) {
    nextOf[i] = after;
    if (bare(block[i]!).trim() !== "") after = i;
  }
  return block.map((line, i) => {
    // A bracket closed that the block never opened leaves the depth below 0, so no later line is at the top either.
    const top = state.depth === 0 && state.open === null;
    const scanned = scanLine(line, state);
    state = scanned.state;
    const code = scanned.code.trimEnd();
    const text = bare(line).trimStart();
    const blank = text.trim() === "";
    const shape: LineShape = {
      top,
      broken: scanned.broken,
      closed: !scanned.broken && state.depth === 0 && state.open === null,
      leavesOpen: state.depth > 0 || state.open !== null,
      code,
      word: WORD.test(code),
      attaches: !blank && ATTACHED.test(text),
      continues: !blank && CONTINUES.test(code),
      joined: attaching || going,
      continued: going,
      least: !blank && indentOf(line) === least,
      opensIndent: false,
      next: nextOf[i]!,
      blank,
    };
    if (!blank) {
      shape.opensIndent = shape.next >= 0 && indentOf(block[shape.next]!) > indentOf(line);
      attaching = shape.attaches;
      // A comment or a decorator only attaches to the next line, whatever it ends with.
      going = shape.continues && !shape.attaches;
    }
    return shape;
  });
}

/**
 * Which lines of an inserted block stand alone: a whole statement or entry on one line. A line does when its code holds
 * a name or a number; it starts and ends outside every bracket, string and comment the block opened before it, closes no
 * bracket it did not open and leaves no one-line string open; it is as little indented as any line of the block, and the
 * next non-blank line is not indented further (it opens no indented block); it does not start like a decorator, an
 * attribute, a comment or a markup tag, nor follow one (they attach to the line after them); and neither its code nor
 * the code of the non-blank line before it ends with an operator, a period or an opening bracket (the statement goes
 * on). Lines ending with a comma (list and registry entries) can stand alone.
 */
export function standaloneLines(block: readonly string[]): boolean[] {
  return standaloneOf(blockShape(block));
}

/** standaloneLines from a block's shapes. */
function standaloneOf(shapes: readonly LineShape[]): boolean[] {
  return shapes.map((s) => s.top && s.closed && s.word && s.least && !s.joined && !s.attaches && !s.continues && !s.opensIndent);
}

/**
 * Which lines of an inserted block open a multi-line construct at its top: a line that starts at the top of the block
 * (as standaloneLines reads it), is as little indented as any line, holds a name or a number of its own, does not start
 * like a decorator, an attribute, a comment or a markup tag, and does not go on from the line before it, but whose
 * construct goes on: it leaves a bracket, string or comment open, its statement continues, or it opens an indented
 * block. A function or class header, a block, a call whose arguments go on; an opening that names nothing (`import {`)
 * is left out, since many constructs open alike.
 */
export function openingLines(block: readonly string[]): boolean[] {
  return openingOf(blockShape(block));
}

/** openingLines from a block's shapes. */
function openingOf(shapes: readonly LineShape[]): boolean[] {
  return shapes.map((s) => s.top && s.word && s.least && !s.continued && !s.attaches && !s.broken && (s.leavesOpen || s.continues || s.opensIndent) && !UNNAMED_OPENING.test(s.code));
}

/**
 * Where an inserted block can be cut in two with whole statements on both sides: index i (0..length) is such a place
 * when nothing the lines before it opened is still open, the last non-blank line before it neither attaches to the
 * next line nor goes on in it, and the next non-blank line from i on is as little indented as any line of the block.
 */
function cutPlaces(shapes: readonly LineShape[]): boolean[] {
  const out: boolean[] = [true];
  let joins = false;
  for (const s of shapes) {
    if (!s.blank) joins = s.attaches || s.continues;
    out.push(s.closed && !joins && (s.next < 0 || shapes[s.next]!.least));
  }
  return out;
}

/**
 * How many lines both insertions start with, and end with, that land once (compared as lineKey reads them): the longest
 * shared start, and then the longest shared end of what is left, each cut back to a place where both insertions can be
 * cut with whole statements on both sides (cutPlaces), and each kept only when it holds a name or a number (shared blank
 * lines and braces are separators each insertion keeps). When both insertions go on past what they share, blank lines at
 * its inner edges stay with each insertion.
 */
export function sharedEnds(ours: readonly string[], theirs: readonly string[]): { head: number; tail: number } {
  return sharedEndsOf(ours, theirs, blockShape(ours), blockShape(theirs));
}

/** sharedEnds from the two blocks and their shapes. */
function sharedEndsOf(ours: readonly string[], theirs: readonly string[], shapesO: readonly LineShape[], shapesT: readonly LineShape[]): { head: number; tail: number } {
  const ko = ours.map(lineKey);
  const kt = theirs.map(lineKey);
  const co = cutPlaces(shapesO);
  const ct = cutPlaces(shapesT);
  const worded = (from: number, to: number): boolean => ours.slice(from, to).some((l) => WORD.test(bare(l)));
  const blank = (i: number): boolean => bare(ours[i]!).trim() === "";
  let head = 0;
  while (head < ko.length && head < kt.length && ko[head] === kt[head]) head++;
  while (head > 0 && !(co[head] && ct[head])) head--;
  if (!worded(0, head)) head = 0;
  let tail = 0;
  const room = Math.min(ko.length, kt.length) - head;
  while (tail < room && ko[ko.length - 1 - tail] === kt[kt.length - 1 - tail]) tail++;
  while (tail > 0 && !(co[ko.length - tail] && ct[kt.length - tail])) tail--;
  if (!worded(ours.length - tail, ours.length)) tail = 0;
  // Both go on past what they share: blank lines at its inner edges separate it from what each goes on with, and each
  // keeps its own (a blank line is a place to cut wherever the line next to it is).
  if (head + tail < ko.length && head + tail < kt.length) {
    while (head > 0 && blank(head - 1)) head--;
    while (tail > 0 && blank(ko.length - tail)) tail--;
  }
  return { head, tail };
}

/**
 * The union of two insertions at one place of the base: `ours` (trunk's inserted lines) first, then `theirs` (the
 * change's). The lines both start with and end with land once, as trunk has them (sharedEnds). Between them, each line
 * of the change that stands alone and equals a standalone line trunk inserted there is left out (each of trunk's lines
 * matches one line of the change; lines compare as lineKey reads them). `atEnd`: the place is the end of the file. Null
 * when the union would land a construct twice (both remaining insertions open a multi-line construct with the same
 * line, openingLines), or would join two lines into one: a line without its ending before another line, or at the end
 * of an insertion that base lines follow.
 */
export function insertionUnion(ours: readonly string[], theirs: readonly string[], atEnd: boolean): string[] | null {
  const shapesO = blockShape(ours);
  const shapesT = blockShape(theirs);
  const { head, tail } = sharedEndsOf(ours, theirs, shapesO, shapesT);
  const oursTo = ours.length - tail;
  const theirsTo = theirs.length - tail;
  const own = standaloneOf(shapesO);
  const other = standaloneOf(shapesT);
  if (head < oursTo && head < theirsTo) {
    // Both insertions hold more than what they share at their ends: the same opening line in both would land twice.
    const opens = openingOf(shapesO);
    const opened = new Set<string>();
    for (let i = head; i < oursTo; i++) if (opens[i]) opened.add(lineKey(ours[i]!));
    const theirOpens = openingOf(shapesT);
    for (let i = head; i < theirsTo; i++) if (theirOpens[i] && opened.has(lineKey(theirs[i]!))) return null;
  }
  const left = new Map<string, number>();
  for (let i = head; i < oursTo; i++) {
    if (own[i]) left.set(lineKey(ours[i]!), (left.get(lineKey(ours[i]!)) ?? 0) + 1);
  }
  const out = ours.slice(0, oursTo);
  for (let i = head; i < theirsTo; i++) {
    const key = lineKey(theirs[i]!);
    const n = other[i] ? (left.get(key) ?? 0) : 0;
    if (n > 0) left.set(key, n - 1);
    else out.push(theirs[i]!);
  }
  for (let i = oursTo; i < ours.length; i++) out.push(ours[i]!);
  for (let i = 0; i < out.length; i++) {
    if (!out[i]!.endsWith("\n") && (i < out.length - 1 || !atEnd)) return null;
  }
  return out;
}
