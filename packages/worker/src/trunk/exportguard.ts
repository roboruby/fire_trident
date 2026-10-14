/**
 * The export guard (FT_EXPORT_GUARD), the deletion guard's counterpart for names: a change that keeps a file but stops
 * exporting a name another trunk file imports breaks trunk the way deleting the file would, and each change is valid
 * alone, so the break shows only when the importer runs. This module reads what a file version exports for the guard
 * (guardExports) and which names a new version removes (removedNames). trunk/imports.ts exportImports gathers a cycle's
 * input from the import index and the cycle's blobs, and trunk/plan.ts brokenExports decides.
 *
 * It never sends a change back on a guess: a version whose exports cannot be read for sure (the export reader cannot
 * parse it, `export *`, CommonJS) has no exports here, and a name the reader may have missed in the new version (a
 * const, let or var list, a destructuring pattern, an export after other code on its line) is never taken as removed.
 */
import type { Id, Path, Sha } from "@fire_trident/core";
import { revalidationEnabled } from "@fire_trident/core";
import { exportedNames, tokenize, type Token } from "../decide/mechanical.ts";
import { SCRIPT_FILE } from "./revert.ts";

/**
 * Is the export guard on for this colony? `setting` is FT_EXPORT_GUARD, read like FT_REVALIDATE: "on" (every colony), a
 * comma-separated list of colony ids, or absent / empty / "off" (no colony).
 */
export function exportGuardEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/**
 * What one file version exports, as the export guard reads it: `names` (exportedNames), and `loose`, every name the
 * version may still export where exportedNames does not list it for sure (see exportGaps).
 */
export interface GuardExports {
  names: ReadonlySet<string>;
  loose: ReadonlySet<string>;
}

/** Larger versions are never read for their exports (their checks are skipped). */
export const GUARD_FILE_BYTES = 512 * 1024;

/** A version that assigns CommonJS exports: its names are not all in export statements. */
const COMMONJS = /\bmodule\s*\.\s*exports\b|\bexports\s*(?:\.\s*[A-Za-z_$]|\[)/;

/** Is this path a script file the export guard reads (JS or TS)? */
export function guardsScript(path: Path): boolean {
  return SCRIPT_FILE.test(path);
}

/**
 * The exports of a script version for the export guard, or null when they cannot be known for sure: the export reader
 * cannot parse it (exportedNames is null), it has `export * from` (its names are not listed), or it assigns CommonJS
 * exports.
 */
export function guardExports(text: string): GuardExports | null {
  const ex = exportedNames(text);
  if (ex === null || ex.star.length > 0 || COMMONJS.test(text)) return null;
  const loose = exportGaps(text);
  return loose === null ? null : { names: ex.names, loose };
}

/** guardExports of a blob's bytes: null too when it is larger than GUARD_FILE_BYTES or not UTF-8 text. */
export function guardExportsOf(bytes: Uint8Array): GuardExports | null {
  const text = guardText(bytes);
  return text === null ? null : guardExports(text);
}

/** A blob's text for the export guard, or null when it is larger than GUARD_FILE_BYTES or not UTF-8. */
export function guardText(bytes: Uint8Array): string | null {
  if (bytes.length > GUARD_FILE_BYTES) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** The names `before` exports that `after` neither exports nor may still export, sorted. */
export function removedNames(before: GuardExports, after: GuardExports): string[] {
  return [...before.names].filter((n) => !after.names.has(n) && !after.loose.has(n)).sort();
}

/**
 * Every name a source may export where exportedNames does not list it: the names of every declarator and destructuring
 * pattern of a top-level `export [declare] const|let|var` statement (exportedNames takes only the first plain name),
 * and every name on the rest of the line after an `export` that does not start a statement (exportedNames skips it, as
 * after a decorator). It over-collects by design. Null when the source cannot be read reliably.
 */
function exportGaps(source: string): Set<string> | null {
  const t = tokenize(source);
  if (t.some((x) => x.kind === "bad")) return null;
  const out = new Set<string>();
  const word = (k: number, ...values: string[]): boolean => t[k]?.kind === "id" && values.includes(t[k]!.value);
  let depth = 0;
  for (let k = 0; k < t.length; k++) {
    const tok = t[k]!;
    if (tok.kind === "punc") {
      if (tok.value === "{") depth++;
      else if (tok.value === "}") depth--;
      continue;
    }
    const prev = t[k - 1];
    if (depth !== 0 || !word(k, "export") || (prev?.kind === "punc" && prev.value === ".")) continue;
    if (prev && prev.line === tok.line && !(prev.kind === "punc" && (prev.value === ";" || prev.value === "}"))) {
      for (let j = k + 1; j < t.length && t[j]!.line === tok.line; j++) if (t[j]!.kind === "id") out.add(t[j]!.value);
      continue;
    }
    let j = k + 1;
    if (word(j, "declare")) j++;
    if (word(j, "const", "let", "var")) declaratorNames(t, j + 1, out);
  }
  return out;
}

/** Tokens that can end an expression, and ones that can start the next statement: a line break between them ends it. */
const ENDS = new Set(["id", "num", "str", "tpl", "re"]);
const CLOSERS = new Set([")", "]", "}"]);

/**
 * The names a declaration list starting at token `from` declares (each declarator's name and every name in a
 * destructuring pattern), into `out`, until the statement ends: a ";" outside brackets, or a line break between a token
 * that can end an expression and one that can start a statement.
 */
function declaratorNames(t: Token[], from: number, out: Set<string>): void {
  let inner = 0;
  let declarator = true;
  /** The bracket depth a destructuring pattern opened at, or -1. */
  let pattern = -1;
  for (let m = from; m < t.length; m++) {
    const x = t[m]!;
    const last = t[m - 1]!;
    const lastEnds = ENDS.has(last.kind) || (last.kind === "punc" && CLOSERS.has(last.value));
    if (inner === 0 && x.line !== last.line && lastEnds && ENDS.has(x.kind)) return;
    if (x.kind === "punc") {
      const v = x.value;
      if (inner === 0 && v === ";") return;
      if (inner === 0 && v === ",") {
        declarator = true;
        continue;
      }
      if (v === "(" || v === "[" || v === "{") {
        if (declarator && pattern === -1 && v !== "(") pattern = inner;
        inner++;
      } else if (CLOSERS.has(v)) {
        if (--inner < 0) return;
        if (pattern === inner) pattern = -1;
      }
      if (pattern === -1) declarator = false;
      continue;
    }
    if (x.kind === "id" && (declarator || pattern !== -1)) out.add(x.value);
    if (pattern === -1) declarator = false;
  }
}

/** Versions whose exports a trunk writer keeps (by blob id, so immutable), at most. */
const MEMO_SIZE = 2_000;
/** After a blob read stalls past the guard's wait, cycles skip the guard this long rather than wait again. */
export const STALL_PAUSE_MS = 60_000;

/**
 * What the export guard keeps across one trunk writer's cycles: the exports of versions it read (by blob id), and until
 * when it sits cycles out after a blob read stalled.
 */
export class ExportMemo {
  private readonly exports = new Map<Sha, GuardExports | null>();
  /** Cycles before this time (ms) skip the guard. */
  stalledUntil = 0;

  /** The exports read for a blob (null: cannot be known), or undefined when not read. */
  get(blob: Sha): GuardExports | null | undefined {
    return this.exports.get(blob);
  }

  /** Keep a blob's exports, dropping the oldest past MEMO_SIZE. */
  set(blob: Sha, value: GuardExports | null): void {
    this.exports.delete(blob);
    this.exports.set(blob, value);
    while (this.exports.size > MEMO_SIZE) {
      const oldest = this.exports.keys().next();
      if (oldest.done) break;
      this.exports.delete(oldest.value);
    }
  }
}
