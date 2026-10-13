import { revalidationEnabled } from "@fire_trident/core";
import type { Id, Path, Sha, Suspect } from "@fire_trident/core";
import { resolveRelative } from "../agents/context.ts";
import { classify, resolveExact, type Compiled } from "./compile.ts";

/**
 * Culprit finding (FT_CULPRITS): when a certification run is red, name the changes that may have
 * broken each failing test file, so a repair agent starts from what broke and why it was written,
 * and a person can undo one proposal (`ft revert <colony> <prp>`).
 *
 * For a test file that was on the last green commit: the files it loads (itself first, then its
 * imports nearest first, and any file a relative import names that is not on trunk), keep the ones
 * whose blob differs between the green commit (TrunkDO.baseBlobs) and the red one (the run's own
 * index), then take the landings since the green commit that changed them. For a test file new since
 * then, or before the first green run: the landings that added or last changed it or what it loads.
 * Landings come from the colony's per-path landing index (CertifyHost.landedOn), never from walking
 * history: newest first, at most three per failing test file, of which the test file's own latest
 * change (when it is among them) always keeps a place. Everything here is bounded, and the
 * certifier gives a lookup SUSPECT_MS: one that fails or takes longer leaves the result without
 * suspects and never fails certification.
 */

/** Failing test files looked at per run, files compared per test file, and paths compared per run (one trunk call). */
export const SUSPECT_FILES = 10;
export const SUSPECT_REACH = 32;
export const SUSPECT_PATHS = 256;
/** Suspects per failing test file, suspects per result, and paths each suspect lists. */
export const SUSPECTS_PER_FILE = 3;
export const SUSPECTS_MAX = 10;
export const SUSPECT_PATHS_LISTED = 10;
/** How long finding suspects may take before the result goes without them. */
export const SUSPECT_MS = 3_000;
/**
 * When the colony no longer has the green commit's landing (a commit FireTrident made itself, such as
 * a revert), a landing older than the green run's start by more than this came before the green commit.
 * A landing's time is taken before its push, so one that landed just after can look a little older.
 */
export const GREEN_SLACK_MS = 60_000;

/** One landing that changed some of the paths asked about (CertifyHost.landedOn), newest first. */
export interface LandedOn {
  landingId: Id;
  at: number;
  trunkSha?: Sha;
  /** The proposal that wrote the paths, when the colony knows exactly one. */
  proposalId?: Id;
  intentId?: Id;
  /** The intent's title and why, one line each ("" when unknown). */
  title: string;
  why: string;
  /** The paths asked about that it changed. */
  paths: Path[];
  /** The blob its proposal wrote for each of those paths (null: deleted), when the colony knows the proposal. */
  wrote?: Record<Path, Sha | null>;
}

/** A suspect with its intent's why, for the repair intent (results keep only the Suspect fields). */
export interface FoundSuspect extends Suspect {
  why: string;
}

/** Is culprit finding on for this colony? `setting` is FT_CULPRITS, read like FT_REVALIDATE: "on", a comma-separated list of colony ids, or absent / "off". */
export function culpritsEnabled(setting: string | undefined, colonyId: Id): boolean {
  return revalidationEnabled(setting, colonyId);
}

/**
 * What a failing test file loads: the file first, then the modules it reaches through relative
 * imports, nearest first, including a file an import names that is not there (a deleted dependency
 * fails its importer without being loaded). At most `max` paths; a file the run did not read (deleted,
 * or never loaded) is only itself.
 */
export function reachOf(file: Path, modules: ReadonlyMap<Path, Compiled> | null, max = SUSPECT_REACH): Path[] {
  const files = new Set(modules?.keys() ?? []);
  const order: Path[] = [file];
  const seen = new Set<Path>(order);
  for (let i = 0; i < order.length && order.length < max; i++) {
    const c = modules?.get(order[i]!);
    if (!c) continue;
    for (const spec of c.imports) {
      if (classify(spec).kind !== "relative") continue;
      const target = resolveExact(c.path, spec, files) ?? resolveRelative(c.path, spec);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      order.push(target);
      if (order.length >= max) break;
    }
  }
  return order;
}

/** The paths whose blob on the red commit differs from the green commit's (paths not looked up on green are left out). */
export function changedSince(paths: readonly Path[], red: (path: Path) => Sha | null, green: ReadonlyMap<Path, Sha | null>): Path[] {
  return paths.filter((p) => green.has(p) && (green.get(p) ?? null) !== red(p));
}

/** The last green commit as culprit finding sees it. */
export interface GreenCommit {
  sha: Sha;
  /** Its landing in the colony, when the colony has it. */
  landing: { landingId: Id; at: number } | null;
  /** When its green run started, when that result is still kept. */
  startedAt: number | null;
}

/**
 * The landings among `found` (newest first) that came after the green commit. Not after it: the
 * green commit's own landing and older ones (or, without that landing, ones older than its run by
 * more than GREEN_SLACK_MS), and, path by path, a landing no newer than one that wrote the green
 * commit's blob of the path: the green version came from that one, so the older ones changed nothing
 * since. A landing stays when at least one of its paths changed after green.
 */
export function afterGreen(found: readonly LandedOn[], green: GreenCommit, blobs: ReadonlyMap<Path, Sha | null>): LandedOn[] {
  const floor = green.landing ? green.landing.at : green.startedAt !== null ? green.startedAt - GREEN_SLACK_MS : -Infinity;
  const wroteGreen = (l: LandedOn, p: Path): boolean => !!l.wrote && Object.hasOwn(l.wrote, p) && blobs.has(p) && (l.wrote[p] ?? null) === (blobs.get(p) ?? null);
  const bound = new Map<Path, number>();
  for (const l of found) for (const p of l.paths) if (wroteGreen(l, p)) bound.set(p, Math.max(bound.get(p) ?? -Infinity, l.at));
  return found.filter((l) => l.landingId !== green.landing?.landingId && l.at >= floor && l.paths.some((p) => !wroteGreen(l, p) && l.at >= (bound.get(p) ?? -Infinity)));
}

/**
 * One result's suspects from each failing file's landings: the newest SUSPECTS_PER_FILE of each file,
 * one entry per landing and proposal (or intent) naming every failing file it is a suspect for and the
 * paths it changed (sorted, at most SUSPECT_PATHS_LISTED), newest first, at most `max`.
 */
export function mergeSuspects(perFile: ReadonlyArray<{ file: Path; found: readonly LandedOn[] }>, max = SUSPECTS_MAX): FoundSuspect[] {
  const by = new Map<string, FoundSuspect>();
  for (const { file, found } of perFile) {
    for (const l of found.slice(0, SUSPECTS_PER_FILE)) {
      const key = `${l.landingId}\u0000${l.proposalId ?? l.intentId ?? ""}`;
      let s = by.get(key);
      if (!s) {
        s = { landingId: l.landingId, at: l.at, paths: [], files: [], why: l.why };
        if (l.trunkSha) s.trunkSha = l.trunkSha;
        if (l.proposalId) s.proposalId = l.proposalId;
        if (l.intentId) s.intentId = l.intentId;
        if (l.title) s.title = l.title;
        by.set(key, s);
      }
      for (const p of l.paths) if (!s.paths.includes(p)) s.paths.push(p);
      if (!s.files.includes(file)) s.files.push(file);
    }
  }
  return [...by.values()]
    .sort((a, b) => b.at - a.at || (a.landingId < b.landingId ? 1 : a.landingId > b.landingId ? -1 : 0))
    .slice(0, Math.max(0, max))
    .map((s) => ({ ...s, paths: [...s.paths].sort().slice(0, SUSPECT_PATHS_LISTED) }));
}

/** What findSuspects needs: the red run, the last green commit, and the two lookups. */
export interface SuspectSearch {
  /** The failing test files, in the result's order (lost files included). */
  files: readonly Path[];
  /** The run's modules (null when it read none). */
  modules: ReadonlyMap<Path, Compiled> | null;
  /** A path's blob on the red commit (null when not on it). */
  red: (path: Path) => Sha | null;
  /** The last green commit, or null before the first green run. */
  green: GreenCommit | null;
  /** Blobs of paths on a commit (TrunkDO.baseBlobs; null when absent, all null for an unknown commit). */
  blobsAt: (sha: Sha, paths: Path[]) => Promise<ReadonlyArray<{ path: Path; blob: Sha | null }>>;
  /** The latest landings that changed any of the paths, newest first (CertifyHost.landedOn). */
  landedOn: (paths: Path[]) => Promise<readonly LandedOn[]>;
}

/** The suspects of a red run (see the module comment), newest first. One trunk call, at most two index lookups per failing file. */
export async function findSuspects(s: SuspectSearch): Promise<FoundSuspect[]> {
  const files = [...new Set(s.files.filter((f) => typeof f === "string" && f !== ""))].slice(0, SUSPECT_FILES);
  if (files.length === 0) return [];
  const reach = new Map(files.map((f) => [f, reachOf(f, s.modules)]));
  let blobs: Map<Path, Sha | null> | null = null;
  if (s.green) {
    // The failing files first (whether each was on the green commit decides how it is searched), then what they load.
    const want: Path[] = [...files];
    const seen = new Set<Path>(want);
    for (const paths of reach.values()) {
      for (const p of paths) {
        if (seen.has(p) || want.length >= SUSPECT_PATHS) continue;
        seen.add(p);
        want.push(p);
      }
    }
    const answer = await s.blobsAt(s.green.sha, want);
    blobs = new Map();
    for (const v of Array.isArray(answer) ? answer : []) if (v && typeof v.path === "string") blobs.set(v.path, typeof v.blob === "string" ? v.blob : null);
  }
  const perFile: Array<{ file: Path; found: readonly LandedOn[] }> = [];
  for (const file of files) {
    const paths = reach.get(file) ?? [file];
    // On the green commit: what changed since. New since then, or no green commit yet: everything it loads.
    const since = s.green !== null && blobs !== null && (blobs.get(file) ?? null) !== null;
    const ask = since ? changedSince(paths, s.red, blobs!) : paths;
    if (ask.length === 0) continue;
    const keep = (found: readonly LandedOn[]): LandedOn[] => (since ? afterGreen(found, s.green!, blobs!) : [...found]);
    // The failing file's own latest change keeps a place (an agent's test can be what is wrong); the rest are the newest that changed what it loads.
    const others = ask.filter((p) => p !== file);
    const own = others.length < ask.length ? keep(await s.landedOn([file])).slice(0, 1) : [];
    const rest = others.length > 0 ? keep(await s.landedOn(others)) : [];
    perFile.push({ file, found: ownFirst(own, rest) });
  }
  return mergeSuspects(perFile);
}

/** The file's own landing (if any) and the newest others, one entry per landing and proposal, at most SUSPECTS_PER_FILE, newest first. */
function ownFirst(own: readonly LandedOn[], rest: readonly LandedOn[]): LandedOn[] {
  const key = (l: LandedOn): string => `${l.landingId}\u0000${l.proposalId ?? l.intentId ?? ""}`;
  const out = own.map((l) => ({ ...l, paths: [...l.paths] }));
  for (const l of rest) {
    const same = out.find((o) => key(o) === key(l));
    if (same) same.paths.push(...l.paths.filter((p) => !same.paths.includes(p)));
    else if (out.length < SUSPECTS_PER_FILE) out.push({ ...l, paths: [...l.paths] });
  }
  return out.sort((a, b) => b.at - a.at);
}

/** A suspect as a result keeps it (without its intent's why). */
export function publicSuspect(s: FoundSuspect): Suspect {
  const { why: _why, ...rest } = s;
  return rest;
}
