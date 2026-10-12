import { checkFile, ruleApplies } from "@fire_trident/core";
import type { Id, Path, Rule, Violation } from "@fire_trident/core";
import type { Env } from "../env.ts";

/** Extensions the morphology checker reads (TypeScript and JavaScript sources). */
export const SOURCE_EXTENSIONS: readonly string[] = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts"];

/** Files larger than this many bytes are skipped: they are generated, vendored, or fixtures. */
export const MAX_SCAN_BYTES = 512 * 1024;

/** Trunk reads in flight at once during a scan. */
export const SCAN_CONCURRENCY = 16;

/** A file handed to the pure checker. */
export interface ScanInput {
  path: Path;
  content: string;
}

/**
 * Does this path look like a hand-written source file? It needs a source
 * extension, must not be a minified bundle, and must not sit under node_modules.
 */
export function isSourcePath(path: Path): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  if (!SOURCE_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase())) return false;
  if (/\.min\.[cm]?js$/i.test(name)) return false;
  return !/(^|\/)node_modules\//.test(path);
}

/** Should a scan of this rule read this path at all (source file and rule globs)? */
export function shouldScan(rule: Rule, path: Path): boolean {
  return isSourcePath(path) && ruleApplies(rule, path);
}

/** Is the UTF-8 encoding of `text` at most `limit` bytes? Counts without allocating. */
export function withinBytes(text: string, limit: number): boolean {
  // UTF-8 never uses fewer bytes than UTF-16 code units, nor more than three per unit.
  if (text.length > limit) return false;
  if (text.length * 3 <= limit) return true;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
    if (bytes > limit) return false;
  }
  return true;
}

/** Order violations by path, then line, so scans are deterministic. */
export function compareViolations(a: Violation, b: Violation): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.line - b.line;
}

/**
 * Evaluate one rule against files already in memory (pure). Applies the same
 * filters as scanRule (rule globs, source extensions, size limit) and returns
 * every violation sorted by path, then line.
 */
export function scanFiles(rule: Rule, files: ReadonlyArray<ScanInput>): Violation[] {
  const out: Violation[] = [];
  for (const file of files) {
    if (!shouldScan(rule, file.path) || !withinBytes(file.content, MAX_SCAN_BYTES)) continue;
    for (const v of checkFile(rule, file.path, file.content)) out.push(v);
  }
  return out.sort(compareViolations);
}

/** Map with at most `limit` calls in flight. Results keep the input order. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lane = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i] as T, i);
    }
  };
  const lanes = Math.min(Math.max(1, Math.floor(limit)), items.length);
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

/**
 * Scan every applicable trunk file for violations of one rule. Lists trunk files
 * from TrunkDO, keeps source files under MAX_SCAN_BYTES that the rule applies to,
 * reads them with bounded concurrency, and checks each one. A file deleted
 * mid-scan is skipped; a read that fails twice is skipped and logged.
 */
export async function scanRule(env: Env, colonyId: Id, rule: Rule): Promise<Violation[]> {
  const trunk = env.TRUNK.get(env.TRUNK.idFromName(colonyId));
  const listing = await trunk.files();
  const paths = listing.filter((f) => f.size <= MAX_SCAN_BYTES && shouldScan(rule, f.path)).map((f) => f.path);

  const unreadable: Path[] = [];
  const read = async (path: Path): Promise<string | null> => {
    try {
      return await trunk.readFile(path);
    } catch {
      return await trunk.readFile(path);
    }
  };
  const files = await mapLimit(paths, SCAN_CONCURRENCY, async (path): Promise<ScanInput | null> => {
    try {
      const content = await read(path);
      return content === null ? null : { path, content };
    } catch {
      unreadable.push(path);
      return null;
    }
  });
  if (unreadable.length > 0) {
    console.warn(`morph scan: rule ${rule.id} skipped ${unreadable.length} unreadable file(s), e.g. ${unreadable.slice(0, 3).join(", ")}`);
  }
  return scanFiles(rule, files.filter((f): f is ScanInput => f !== null));
}
