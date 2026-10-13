import { footprintCovers } from "@fire_trident/core";
import type { Id, LandingNotice, Path, Sha } from "@fire_trident/core";
import { oneLine } from "./change.ts";
import { parseIntentSpec } from "./create.ts";

/**
 * What landed on an intent's files, for the agents that work on them (pure helpers; no I/O).
 *
 * At take, the colony hands the agent the latest landings that changed its footprint files, each with
 * the intent it completed and that intent's why: why the code is the way it is. The colony keeps a
 * small index for it (which landing and intent changed each path, the newest few per path), so a take
 * costs a few indexed lookups, never a trunk call. While an agent works, a landing that changes files
 * its intent covers reaches it as a landing notice (colony/direction.ts, landingMessage).
 */

/** Landings one take carries at most, landings kept per path in the index, characters of a why, paths listed per landing. */
export const WHY_LANDINGS = 3;
export const WHY_PER_PATH = 3;
export const WHY_CHARS = 300;
export const WHY_PATHS = 10;
/** Footprint entries looked up per take, and index rows read for one directory or glob entry. */
export const WHY_FOOTPRINT = 20;
export const WHY_RANGE_ROWS = 300;
const TITLE_CHARS = 200;

/** One landing that changed files in an intent's footprint (ColonyDO.take's `context`), newest first. */
export interface LandedWhy {
  landingId: Id;
  at: number;
  /** The trunk commit, when the colony still has the landing. */
  trunkSha?: Sha;
  /** The intent the landing completed for these files (absent for a commit made outside an intent). */
  intentId?: Id;
  /** That intent's title and why (one line, about WHY_CHARS characters); "" when unknown. */
  title: string;
  why: string;
  /** The footprint files it changed. */
  paths: Path[];
}

/** One index row: a landing (and the intent it completed) changed this path. */
export interface LandedRow {
  path: Path;
  at: number;
  landingId: Id;
  intentId: Id | null;
}

/** Characters that make a footprint entry a glob. */
const GLOB = /[*?{]/;

/** Is this footprint entry one exact path (no glob, not a directory)? */
export function isLiteralEntry(entry: string): boolean {
  return entry !== "" && !GLOB.test(entry) && !entry.endsWith("/");
}

/**
 * How the landing index is searched for one footprint entry: an exact path, or the range of paths
 * under a directory or a glob's literal head (to filter with footprintCovers). Null when the entry
 * names nothing searchable (empty, or a glob with no literal directory in front, such as "**").
 */
export function indexRange(entry: string): { eq: Path } | { from: Path; to: Path } | null {
  const e = entry.startsWith("./") ? entry.slice(2) : entry;
  if (e === "") return null;
  if (isLiteralEntry(e)) return { eq: e };
  const head = GLOB.test(e) ? e.slice(0, e.search(GLOB)) : e;
  const prefix = head.slice(0, head.lastIndexOf("/") + 1);
  if (prefix === "") return null;
  // U+10FFFF sorts after every character a path can hold (SQLite compares UTF-8 bytes).
  return { from: prefix, to: `${prefix}\u{10FFFF}` };
}

/** Footprints indexed for matching landed paths: exact entries by path, directories and globs as patterns. */
export interface FootprintIndex<T> {
  exact: Map<Path, T[]>;
  patterns: Array<{ entry: string; ref: T }>;
}

/** Index footprints (of the intents agents hold) so a landing finds the ones covering its paths without a scan. */
export function footprintIndex<T>(items: Iterable<{ footprint: readonly string[]; ref: T }>): FootprintIndex<T> {
  const exact = new Map<Path, T[]>();
  const patterns: Array<{ entry: string; ref: T }> = [];
  for (const { footprint, ref } of items) {
    for (const raw of new Set(footprint)) {
      const entry = raw.startsWith("./") ? raw.slice(2) : raw;
      if (entry === "") continue;
      if (!isLiteralEntry(entry)) {
        patterns.push({ entry, ref });
        continue;
      }
      const list = exact.get(entry);
      if (list) list.push(ref);
      else exact.set(entry, [ref]);
    }
  }
  return { exact, patterns };
}

/** Which indexed footprints cover the landed paths, each with the landed paths it covers (sorted). */
export function coveringFootprints<T>(index: FootprintIndex<T>, landed: readonly Path[]): Array<{ ref: T; paths: Path[] }> {
  const out = new Map<T, Set<Path>>();
  const add = (ref: T, path: Path): void => {
    const set = out.get(ref);
    if (set) set.add(path);
    else out.set(ref, new Set([path]));
  };
  for (const p of landed) for (const ref of index.exact.get(p) ?? []) add(ref, p);
  for (const { entry, ref } of index.patterns) for (const p of landed) if (footprintCovers(entry, p)) add(ref, p);
  return [...out].map(([ref, paths]) => ({ ref, paths: [...paths].sort() }));
}

/**
 * The latest landings among index rows that changed files the footprint covers: one entry per landing
 * and intent (a group commit can carry several intents), newest first, at most `limit`, each with the
 * footprint paths it changed (sorted, at most WHY_PATHS).
 */
export function pickLanded(rows: readonly LandedRow[], footprint: readonly string[], limit = WHY_LANDINGS): Array<Omit<LandedWhy, "title" | "why" | "trunkSha">> {
  const groups = new Map<string, { landingId: Id; at: number; intentId: Id | null; paths: Set<Path> }>();
  for (const r of rows) {
    if (!r.path || !r.landingId || !footprint.some((e) => footprintCovers(e, r.path))) continue;
    const key = `${r.landingId}\u0000${r.intentId ?? ""}`;
    const g = groups.get(key) ?? { landingId: r.landingId, at: r.at, intentId: r.intentId, paths: new Set<Path>() };
    g.at = Math.max(g.at, r.at);
    g.paths.add(r.path);
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.at - a.at || (a.landingId < b.landingId ? 1 : a.landingId > b.landingId ? -1 : 0))
    .slice(0, Math.max(0, limit))
    .map((g) => ({ landingId: g.landingId, at: g.at, ...(g.intentId ? { intentId: g.intentId } : {}), paths: [...g.paths].sort().slice(0, WHY_PATHS) }));
}

/** An intent's why as a take shows it: its own text (no spec layout lines or spec context), one line, cut to `max`. */
export function shortWhy(why: string | null | undefined, max = WHY_CHARS): string {
  const own = parseIntentSpec(why ?? "").why || (why ?? "");
  const t = oneLine(own);
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** An intent title as a take shows it: one line, cut to 200 characters. */
export function shortTitle(title: string | null | undefined): string {
  const t = oneLine(title ?? "");
  return t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS - 1)}…` : t;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * A take's `context` received over RPC, checked and capped (a colony on the previous version sends
 * none; malformed entries are dropped). Undefined when nothing usable is left.
 */
export function cleanContext(x: unknown): LandedWhy[] | undefined {
  if (!Array.isArray(x)) return undefined;
  const out: LandedWhy[] = [];
  for (const raw of x) {
    if (out.length >= WHY_LANDINGS) break;
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (typeof e.landingId !== "string" || !e.landingId || typeof e.at !== "number" || !Number.isFinite(e.at)) continue;
    const paths = (Array.isArray(e.paths) ? e.paths : []).filter((p): p is string => typeof p === "string" && p !== "").slice(0, WHY_PATHS);
    if (paths.length === 0) continue;
    const entry: LandedWhy = {
      landingId: e.landingId,
      at: e.at,
      title: shortTitle(typeof e.title === "string" ? e.title : ""),
      why: typeof e.why === "string" ? shortWhy(e.why) : "",
      paths,
    };
    if (typeof e.trunkSha === "string" && SHA.test(e.trunkSha)) entry.trunkSha = e.trunkSha;
    if (typeof e.intentId === "string" && e.intentId) entry.intentId = e.intentId;
    out.push(entry);
  }
  return out.length > 0 ? out : undefined;
}

/** The why-context entry a landing notice makes: the landing that just changed the job's files. */
export function noticeEntry(n: LandingNotice, at: number): LandedWhy {
  return { landingId: n.landingId, at, trunkSha: n.trunkSha, title: shortTitle(n.intentTitle), why: shortWhy(n.why), paths: n.paths.map((p) => p.path).slice(0, WHY_PATHS) };
}

/** Put a landing first in a job's why-context (one entry per landing and title, at most WHY_LANDINGS). */
export function withLanded(list: readonly LandedWhy[] | undefined, entry: LandedWhy): LandedWhy[] {
  const rest = (list ?? []).filter((e) => !(e.landingId === entry.landingId && e.title === entry.title));
  return [entry, ...rest].slice(0, WHY_LANDINGS);
}
