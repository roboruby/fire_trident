/**
 * The insertion rule of text merge (FT_MERGE_INSERTIONS, core/textmerge.ts mergeText with `insertions`): two changes
 * that each only inserted lines at the same place of the base conflict under git's rules, though both insertions can
 * usually stand. The rule lands their union: trunk's lines first, then the change's lines, without the lines trunk
 * already inserted there. Pure and synchronous.
 *
 * A line of the change counts as already inserted only when it equals one of trunk's inserted lines and the line stands
 * alone in both insertions (standaloneLines): a whole statement or entry on one line. A closing brace, a blank line, a
 * decorator or a line inside a multi-line construct is never dropped, so two functions added at the end of one file
 * both land whole, while an import or an export line both sides added lands once.
 */

/** First non-blank characters of a line that attaches to the line after it: decorators, attributes, comments, markup. */
const ATTACHED = /^(@|#|\/\/|\/\*|\*|<|\[|--)/;
/** Last characters of a line's code whose statement or expression goes on in the next line (a sentence's period too). */
const CONTINUES = /[\\=+\-*/%&|^.?:<>!~([{]$/;
/** A character of a name or a number: a line without one (a brace, a blank line) is never a statement of its own. */
const WORD = /[A-Za-z0-9_$]/;

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
  const indents = block.filter((l) => bare(l).trim() !== "").map(indentOf);
  const least = indents.length > 0 ? Math.min(...indents) : 0;
  let state: ScanState = { depth: 0, open: null };
  // Whether the last non-blank line attaches to the next one, or its statement goes on in it.
  let joins = false;
  return block.map((line, i) => {
    const top = state.depth === 0 && state.open === null;
    const scanned = scanLine(line, state);
    state = scanned.state;
    const code = scanned.code.trimEnd();
    const text = bare(line).trimStart();
    const joined = joins;
    if (text.trim() !== "") joins = ATTACHED.test(text) || CONTINUES.test(code);
    if (joined || !top || scanned.broken || state.depth !== 0 || state.open !== null) return false;
    if (!WORD.test(code) || indentOf(line) !== least || ATTACHED.test(text) || CONTINUES.test(code)) return false;
    const next = block.slice(i + 1).find((l) => bare(l).trim() !== "");
    return next === undefined || indentOf(next) <= indentOf(line);
  });
}

/**
 * The union of two insertions at one place of the base: `ours` (trunk's inserted lines) first, then `theirs` (the
 * change's), leaving out each line of the change that stands alone and equals a standalone line trunk inserted (each of
 * trunk's lines matches one line of the change; line endings are not compared). `atEnd`: the place is the end of the
 * file. Null when the union would join two lines into one: a line without its ending before another line, or at the
 * end of an insertion that base lines follow.
 */
export function insertionUnion(ours: readonly string[], theirs: readonly string[], atEnd: boolean): string[] | null {
  const own = standaloneLines(ours);
  const other = standaloneLines(theirs);
  const left = new Map<string, number>();
  ours.forEach((line, i) => {
    if (own[i]) left.set(bare(line), (left.get(bare(line)) ?? 0) + 1);
  });
  const out = [...ours];
  theirs.forEach((line, i) => {
    const n = other[i] ? (left.get(bare(line)) ?? 0) : 0;
    if (n > 0) left.set(bare(line), n - 1);
    else out.push(line);
  });
  for (let i = 0; i < out.length; i++) {
    if (!out[i]!.endsWith("\n") && (i < out.length - 1 || !atEnd)) return null;
  }
  return out;
}
