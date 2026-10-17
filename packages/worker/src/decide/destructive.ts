import type { CheckResult, Path, Sha } from "@fire_trident/core";
import { guardExports, guardsScript, removedNames, type GuardExports } from "../trunk/exportguard.ts";
import { splitLines } from "./diff.ts";

/**
 * Destructive changes: deterministic facts about what a change takes away, read from the change itself (no model).
 * - deleted: a file the change deletes (a write of no blob).
 * - renamed: a deleted file whose content reappears in a file the change creates (the same blob, or at least
 *   RENAME_SIMILARITY of its lines). A proposal's write set records a rename as exactly that, a deletion plus a write.
 * - export-removed: a name a JS or TS module stops exporting, read by the export guard's reader (trunk/exportguard.ts).
 * - net-removal: a file that loses NET_REMOVAL_LINES lines or more net, a file of HALF_FILE_MIN_LINES lines or more
 *   that loses more than half of them, or modified files that lose NET_REMOVAL_LINES lines or more together.
 * Earned autonomy (gate rule R3) lands none of these, and it needs the fact computed: a file it cannot read to tell
 * (not text, an old or new text that could not be read, exports the reader cannot read for sure) leaves the fact
 * unknown, and autonomy does not apply. A deterministic proof (D3, M1) does not land a destructive change alone
 * either. Either way the change goes to the second opinion; nothing here sends a change to a person. The deletion and
 * export guards (FT_DELETION_GUARD, FT_EXPORT_GUARD) are different: they send back a change that would break a trunk
 * file's import when it lands, and say nothing about a deletion or a removed export that no file imports.
 * Pure: no I/O, and destructiveFact never throws.
 */

/**
 * A file that loses at least this many lines net (its lines before minus its lines after), or modified files that
 * lose this many together, make a large removal. Two hundred lines is more than most focused changes touch in all; a
 * change that takes away that much removes a feature or rewrites a module, which deserves a second look even in a
 * region that has earned trust for its everyday changes.
 */
export const NET_REMOVAL_LINES = 200;

/**
 * A file of at least this many lines that loses more than half of them net is a large removal too: a file that size
 * has a body worth keeping, and gutting it is not an everyday edit. Smaller files are left out, because rewriting most
 * of a short file (a config, a stub, a ten-line helper) is ordinary.
 */
export const HALF_FILE_MIN_LINES = 40;

/** A deleted file whose non-blank lines make up at least this share of a file the change creates was renamed to it. */
export const RENAME_SIMILARITY = 0.5;

/** Deleted and created file pairs compared line by line at most; past that only identical blobs count as renames. */
const RENAME_PAIRS = 400;
/** Entries a fact keeps (hits and unknowns each), and entries a sentence names before "and N more". */
const MAX_ENTRIES = 50;
const NAMED = 5;

/** What one destructive entry is. */
export type DestructiveKind = "deleted" | "renamed" | "export-removed" | "net-removal";

/** One thing a change takes away. */
export interface DestructiveHit {
  kind: DestructiveKind;
  /** The file; absent for a removal across the change's files. */
  path?: Path;
  /** renamed: the path the file became. */
  to?: Path;
  /** export-removed: the names the file stops exporting. */
  names?: string[];
  /** net-removal: lines removed net, and the lines the file had (absent across files). */
  lines?: number;
  of?: number;
  /** What the change does, in plain words ("deletes src/x.ts"). */
  label: string;
}

/** What a change takes away, and what could not be read to tell. */
export interface DestructiveFact {
  /** Empty: the change takes nothing away. */
  hits: DestructiveHit[];
  /** Files the fact could not be read for, in plain words ("src/x.js: its exports cannot be read for sure"). Any: autonomy does not apply. */
  unknown: string[];
}

/** One written file as the fact reads it (colony/innate.ts InnateFile has this shape). */
export interface DestructiveFile {
  path: Path;
  beforeBlob: Sha | null;
  afterBlob: Sha | null;
  /** Old text (null: new file, binary, too large or unreadable). */
  before: string | null;
  /** New text (null: deleted, binary, too large or unreadable). */
  after: string | null;
  binary?: boolean;
  unreadable?: boolean;
}

/** "a", "a and b", "a, b and c": the first NAMED, then "and N more". */
function list(xs: readonly string[]): string {
  if (xs.length > NAMED) return `${xs.slice(0, NAMED).join(", ")} and ${xs.length - NAMED} more`;
  return xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}

/** Share of the larger file's non-blank lines the two files have in common (each line counted as often as both have it). */
function similarity(a: string, b: string): number {
  const x = splitLines(a).map((l) => l.trim()).filter(Boolean);
  const y = splitLines(b).map((l) => l.trim()).filter(Boolean);
  if (x.length === 0 || y.length === 0) return 0;
  const left = new Map<string, number>();
  for (const l of x) left.set(l, (left.get(l) ?? 0) + 1);
  let shared = 0;
  for (const l of y) {
    const n = left.get(l) ?? 0;
    if (n > 0) {
      shared++;
      left.set(l, n - 1);
    }
  }
  return shared / Math.max(x.length, y.length);
}

/** The created file a deleted one became, or null: the same blob first, else the most similar text at RENAME_SIMILARITY or more. */
function renamedTo(gone: DestructiveFile, created: readonly DestructiveFile[], taken: ReadonlySet<Path>, compare: boolean): Path | null {
  const open = created.filter((c) => !taken.has(c.path));
  const same = gone.beforeBlob === null ? undefined : open.find((c) => c.afterBlob === gone.beforeBlob);
  if (same) return same.path;
  if (!compare || gone.before === null) return null;
  let best: Path | null = null;
  let score = RENAME_SIMILARITY;
  for (const c of open) {
    if (c.after === null) continue;
    const s = similarity(gone.before, c.after);
    if (s >= score) {
      best = c.path;
      score = s;
    }
  }
  return best;
}

/**
 * The names `before` exports that `after` does not (removedNames, the export guard's rule), plus the names the guard's
 * loose reading finds in `before` (the second declarator of `export const a = 1, b = 2`) that `after` neither exports
 * nor may still export.
 */
function removedExports(before: GuardExports, after: GuardExports): string[] {
  const kept = (n: string): boolean => after.names.has(n) || after.loose.has(n);
  return [...new Set([...removedNames(before, after), ...[...before.loose].filter((n) => !kept(n))])].sort();
}

/** What a change takes away (see the module comment). Never throws: a failure of its own leaves the fact unknown. */
export function destructiveFact(files: readonly DestructiveFile[]): DestructiveFact {
  try {
    return readFact(files);
  } catch (err) {
    return { hits: [], unknown: [`the destructive check could not run (${err instanceof Error ? err.message : String(err)})`.slice(0, 300)] };
  }
}

function readFact(files: readonly DestructiveFile[]): DestructiveFact {
  const hits: DestructiveHit[] = [];
  const unknown: string[] = [];
  const deleted = files.filter((f) => f.afterBlob === null);
  const created = files.filter((f) => f.beforeBlob === null && f.afterBlob !== null);

  // Deletions, each paired with the created file it became when there is one (a rename).
  const taken = new Set<Path>();
  const compare = deleted.length * created.length <= RENAME_PAIRS;
  for (const gone of deleted) {
    const to = renamedTo(gone, created, taken, compare);
    if (to !== null) {
      taken.add(to);
      hits.push({ kind: "renamed", path: gone.path, to, label: `renames ${gone.path} to ${to}` });
    } else {
      hits.push({ kind: "deleted", path: gone.path, label: `deletes ${gone.path}` });
    }
  }

  // Modified files: removed exports and large removals. A created file only adds.
  let net = 0;
  let read = 0;
  let large = false;
  for (const f of files) {
    if (f.afterBlob === null || f.beforeBlob === null) continue;
    if (f.unreadable) {
      unknown.push(`${f.path}: its new text could not be read`);
      continue;
    }
    if (f.binary) {
      unknown.push(`${f.path}: it is not text, so what it removes cannot be read`);
      continue;
    }
    if (f.before === null || f.after === null) {
      unknown.push(`${f.path}: its ${f.before === null ? "old" : "new"} text could not be read`);
      continue;
    }
    read++;
    if (f.before === f.after) continue;
    const had = splitLines(f.before).length;
    const lost = had - splitLines(f.after).length;
    net += lost;
    if (lost >= NET_REMOVAL_LINES || (had >= HALF_FILE_MIN_LINES && lost * 2 > had)) {
      large = true;
      hits.push({ kind: "net-removal", path: f.path, lines: lost, of: had, label: `removes ${lost} lines net from ${f.path}, which had ${had}` });
    }
    if (!guardsScript(f.path)) continue;
    const was = guardExports(f.before);
    const now = guardExports(f.after);
    if (was === null || now === null) {
      unknown.push(`${f.path}: its exports cannot be read for sure`);
      continue;
    }
    const names = removedExports(was, now);
    if (names.length > 0) hits.push({ kind: "export-removed", path: f.path, names, label: `removes the export${names.length === 1 ? "" : "s"} ${list(names)} from ${f.path}` });
  }
  if (!large && net >= NET_REMOVAL_LINES) hits.push({ kind: "net-removal", lines: net, label: `removes ${net} lines net across ${read} files` });
  return { hits: hits.slice(0, MAX_ENTRIES), unknown: unknown.slice(0, MAX_ENTRIES) };
}

/**
 * Why earned autonomy does not land a change, in a plain sentence, or null when it may: the fact must be computed
 * (absent: it was not), read for every file, and name nothing destructive.
 */
export function autonomyRefusal(fact: DestructiveFact | null | undefined): string | null {
  if (!fact) return "Earned autonomy needs to know whether a change is destructive, and that was not computed for this one";
  if (fact.hits.length > 0) return `Earned autonomy does not land destructive changes: this change ${list(fact.hits.map((h) => h.label))}`;
  if (fact.unknown.length > 0) return `Earned autonomy needs to know whether a change is destructive, and this one could not be read to tell (${list(fact.unknown)})`;
  return null;
}

/** Why a deterministic proof does not land a change alone, in a plain sentence, or null: only a destructive entry stops it. */
export function proofRefusal(fact: DestructiveFact | null | undefined): string | null {
  if (!fact || fact.hits.length === 0) return null;
  return `A deterministic proof does not land destructive changes alone: this change ${list(fact.hits.map((h) => h.label))}`;
}

/** The evidence check (the review card and the Why tab show it): what the change takes away, or that it takes nothing away. */
export function destructiveCheck(fact: DestructiveFact): CheckResult {
  const parts: string[] = [];
  if (fact.hits.length > 0) parts.push(`destructive: ${fact.hits.map((h) => h.label).join("; ")}; earned autonomy does not land it, and a deterministic proof does not land it alone`);
  if (fact.unknown.length > 0) parts.push(`could not tell whether it is destructive: ${fact.unknown.join("; ")}; earned autonomy does not apply`);
  return {
    name: "destructive changes",
    ok: parts.length === 0,
    ms: 0,
    detail: (parts.length > 0 ? parts.join(" | ") : "takes nothing away: no file deleted or renamed, no export removed, no large removal").slice(0, 1_000),
  };
}

/** The fact as a decision record keeps it: nothing when the change takes nothing away and every file was read. */
export function destructiveRecord(fact: DestructiveFact): { destructive?: DestructiveFact } {
  return fact.hits.length > 0 || fact.unknown.length > 0 ? { destructive: fact } : {};
}
