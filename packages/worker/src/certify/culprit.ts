import { revalidationEnabled } from "@fire_trident/core";
import type { Id, Path, Sha, Suspect, SuspectLabel } from "@fire_trident/core";
import { resolveRelative } from "../agents/context.ts";
import { classify, importsFor, resolveFor, type Compiled } from "./compile.ts";

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
 * change (when it is among them) always keeps a place. That index keeps only the newest few landings
 * of each path, so for a test file that was on the green commit the oldest landing since then that
 * changed what it loads comes from the colony's landing log (CertifyHost.landedOn with `since`): it
 * keeps a place beside the newest two, labeled `first-since-green` (every later one landed on a trunk
 * that may already have been red), and the newest are labeled `latest`; no cap drops it. Everything
 * here is bounded, and the certifier gives a lookup SUSPECT_MS: one that fails or takes longer leaves
 * the result without suspects and never fails certification.
 */

/** Failing test files looked at per run, files compared per test file, and paths compared per run (one trunk call). */
export const SUSPECT_FILES = 10;
export const SUSPECT_REACH = 32;
export const SUSPECT_PATHS = 256;
/**
 * Suspects per failing test file, of which the newest ones when the first landing since green has a place too, suspects
 * per result, and paths each suspect lists.
 */
export const SUSPECTS_PER_FILE = 3;
export const LATEST_PER_FILE = 2;
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
  // A vitest test file reaches what vite resolves its imports to (an extensionless path names the .ts file).
  const runner = modules?.get(file)?.runner ?? "node:test";
  const order: Path[] = [file];
  const seen = new Set<Path>(order);
  for (let i = 0; i < order.length && order.length < max; i++) {
    const c = modules?.get(order[i]!);
    if (!c) continue;
    for (const spec of importsFor(c, runner)) {
      if (classify(spec).kind !== "relative") continue;
      const target = resolveFor(runner, c.path, spec, files) ?? resolveRelative(c.path, spec);
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

/** Where the landings since a green commit start (CertifyHost.landedOn's `since`): its landing's time, and that landing when the colony has it. */
export interface SinceGreen {
  at: number;
  landingId: Id | null;
}

/** Where the landings since this green commit start (its landing, else its run's start less GREEN_SLACK_MS), or null when nothing dates it. */
export function sinceGreen(green: GreenCommit): SinceGreen | null {
  if (green.landing) return { at: green.landing.at, landingId: green.landing.landingId };
  if (green.startedAt !== null) return { at: green.startedAt - GREEN_SLACK_MS, landingId: null };
  return null;
}

/**
 * The landings among `found` (newest first) that came after the green commit. Not after it: the
 * green commit's own landing and older ones (or, without that landing, ones older than its run by
 * more than GREEN_SLACK_MS), and, path by path, a landing no newer than one that wrote the green
 * commit's blob of the path: the green version came from that one, so the older ones changed nothing
 * since. A landing stays when at least one of its paths changed after green.
 */
export function afterGreen(found: readonly LandedOn[], green: GreenCommit, blobs: ReadonlyMap<Path, Sha | null>): LandedOn[] {
  const floor = sinceGreen(green)?.at ?? -Infinity;
  const wroteGreen = (l: LandedOn, p: Path): boolean => !!l.wrote && Object.hasOwn(l.wrote, p) && blobs.has(p) && (l.wrote[p] ?? null) === (blobs.get(p) ?? null);
  const bound = new Map<Path, number>();
  for (const l of found) for (const p of l.paths) if (wroteGreen(l, p)) bound.set(p, Math.max(bound.get(p) ?? -Infinity, l.at));
  return found.filter((l) => l.landingId !== green.landing?.landingId && l.at >= floor && l.paths.some((p) => !wroteGreen(l, p) && l.at >= (bound.get(p) ?? -Infinity)));
}

/**
 * The oldest of `candidates` (oldest first: CertifyHost.landedOn with `since`) that came after the green commit, judged
 * with `newer` (the index's newest landings on the same paths) too, since one of those may have written a path's green
 * version back. Null when none did.
 */
export function firstAfterGreen(candidates: readonly LandedOn[], newer: readonly LandedOn[], green: GreenCommit, blobs: ReadonlyMap<Path, Sha | null>): LandedOn | null {
  if (candidates.length === 0) return null;
  const want = new Set(candidates.map(landedKey));
  let first: LandedOn | null = null;
  for (const l of afterGreen([...candidates, ...newer], green, blobs)) if (want.has(landedKey(l)) && (first === null || l.at < first.at)) first = l;
  return first;
}

/** The order labels are listed in. */
const LABELS: readonly SuspectLabel[] = ["first-since-green", "latest", "first-red"];

/**
 * One failing file's suspects with their labels. With its first landing since green known: that one
 * (`first-since-green`, and `latest` too when fewer than LATEST_PER_FILE others came after it) and the
 * newest LATEST_PER_FILE others (`latest`), of which the file's own latest change keeps a place. Without
 * it: the newest SUSPECTS_PER_FILE (`latest`).
 */
function pickForFile(file: Path, found: readonly LandedOn[], first: LandedOn | null): Array<{ l: LandedOn; labels: SuspectLabel[] }> {
  if (!first) return found.slice(0, SUSPECTS_PER_FILE).map((l) => ({ l, labels: ["latest"] }));
  const key = landedKey(first);
  const latest = newestKeepingOwn(
    found.filter((l) => landedKey(l) !== key),
    file,
    LATEST_PER_FILE,
  );
  // The index's entry for the same landing, when it has one, adds the paths it found.
  const same = found.filter((l) => landedKey(l) === key).map((l) => ({ l, labels: ["first-since-green"] as SuspectLabel[] }));
  return [
    ...latest.map((l) => ({ l, labels: ["latest"] as SuspectLabel[] })),
    ...same,
    { l: first, labels: latest.length < LATEST_PER_FILE ? ["first-since-green", "latest"] : ["first-since-green"] },
  ];
}

/** The newest `n` of `list` (newest first), the newest that changed `file` itself replacing the last when none of them did. */
function newestKeepingOwn(list: readonly LandedOn[], file: Path, n: number): LandedOn[] {
  const out = list.slice(0, n);
  if (out.length > 0 && !out.some((l) => l.paths.includes(file))) {
    const own = list.slice(n).find((l) => l.paths.includes(file));
    if (own) out[out.length - 1] = own;
  }
  return out.sort((a, b) => b.at - a.at);
}

/**
 * One result's suspects from each failing file's landings (see pickForFile): one entry per landing
 * and proposal (or intent) naming every failing file it is a suspect for, the paths it changed (sorted,
 * at most SUSPECT_PATHS_LISTED) and its labels for any of them, newest first, at most `max` (capSuspects:
 * the first landings since green are kept before newer ones).
 */
export function mergeSuspects(perFile: ReadonlyArray<{ file: Path; found: readonly LandedOn[]; first?: LandedOn | null }>, max = SUSPECTS_MAX): FoundSuspect[] {
  const by = new Map<string, FoundSuspect & { labels: SuspectLabel[] }>();
  for (const { file, found, first } of perFile) {
    for (const { l, labels } of pickForFile(file, found, first ?? null)) {
      const key = landedKey(l);
      let s = by.get(key);
      if (!s) {
        s = { landingId: l.landingId, at: l.at, paths: [], files: [], why: l.why, labels: [] };
        if (l.trunkSha) s.trunkSha = l.trunkSha;
        if (l.proposalId) s.proposalId = l.proposalId;
        if (l.intentId) s.intentId = l.intentId;
        if (l.title) s.title = l.title;
        by.set(key, s);
      }
      for (const p of l.paths) if (!s.paths.includes(p)) s.paths.push(p);
      if (!s.files.includes(file)) s.files.push(file);
      for (const label of labels) if (!s.labels.includes(label)) s.labels.push(label);
    }
  }
  const all = [...by.values()].sort((a, b) => b.at - a.at || (a.landingId < b.landingId ? 1 : a.landingId > b.landingId ? -1 : 0));
  return capSuspects(all, max).map((s) => ({ ...s, paths: [...s.paths].sort().slice(0, SUSPECT_PATHS_LISTED), labels: LABELS.filter((x) => s.labels.includes(x)) }));
}

/** Does this suspect carry the label? (Suspects recorded before labels existed carry none.) */
export function hasLabel(s: Pick<Suspect, "labels">, label: SuspectLabel): boolean {
  return Array.isArray(s.labels) && s.labels.includes(label);
}

/**
 * At most `n` of a result's suspects (newest first), in the same order: the ones labeled `first-red`,
 * then `first-since-green`, are kept before the newest others, so a cap never drops the change the
 * tests most likely broke at. Suspects without labels are cut newest first, as before.
 */
export function capSuspects<T extends Pick<Suspect, "labels">>(list: readonly T[], n: number): T[] {
  const max = Math.max(0, Math.floor(n));
  if (list.length <= max) return [...list];
  const rank = (s: T): number => (hasLabel(s, "first-red") ? 0 : hasLabel(s, "first-since-green") ? 1 : 2);
  const kept = new Set(
    list
      .map((s, i) => ({ r: rank(s), i }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .slice(0, max)
      .map((x) => x.i),
  );
  return list.filter((_, i) => kept.has(i));
}

/**
 * A result's suspects with the first red search's landing marked `first-red`: the search ends after
 * the suspects were recorded (bisect.ts), so the mark is added to the stored result then. Suspects of
 * other landings are returned as they were.
 */
export function markFirstRed<T extends Suspect>(suspects: readonly T[], landingId: Id): T[] {
  return suspects.map((s) => (s && s.landingId === landingId && !hasLabel(s, "first-red") ? { ...s, labels: [...(Array.isArray(s.labels) ? s.labels : []), "first-red"] } : s));
}

/** One entry per landing and proposal (or intent). */
function landedKey(l: LandedOn): string {
  return `${l.landingId}\u0000${l.proposalId ?? l.intentId ?? ""}`;
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
  /**
   * The oldest landings at or after `since` that changed any of the paths, oldest first, from the colony's landing log
   * (CertifyHost.landedOn with `since`); none when the log may no longer hold them all. Absent: no first landing since green.
   */
  landedSince?: (paths: Path[], since: SinceGreen) => Promise<readonly LandedOn[]>;
}

/** The suspects of a red run (see the module comment), newest first. One trunk call, at most two index lookups and one landing log lookup per failing file. */
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
  const perFile: Array<{ file: Path; found: readonly LandedOn[]; first?: LandedOn }> = [];
  const since = s.green ? sinceGreen(s.green) : null;
  for (const file of files) {
    const paths = reach.get(file) ?? [file];
    // On the green commit: what changed since. New since then, or no green commit yet: everything it loads.
    const onGreen = s.green !== null && blobs !== null && (blobs.get(file) ?? null) !== null;
    const ask = onGreen ? changedSince(paths, s.red, blobs!) : paths;
    if (ask.length === 0) continue;
    const keep = (found: readonly LandedOn[]): LandedOn[] => (onGreen ? afterGreen(found, s.green!, blobs!) : [...found]);
    // The failing file's own latest change keeps a place (an agent's test can be what is wrong); the rest are the newest that changed what it loads.
    const others = ask.filter((p) => p !== file);
    const ownFound = others.length < ask.length ? await s.landedOn([file]) : [];
    const restFound = others.length > 0 ? await s.landedOn(others) : [];
    const own = keep(ownFound).slice(0, 1);
    const rest = keep(restFound);
    // On the green commit: the oldest landing since then that changed what it loads, from the landing log (the index keeps only the newest few).
    const first = onGreen && since && s.landedSince ? firstAfterGreen(await firstLookup(s.landedSince, ask, since), [...ownFound, ...restFound], s.green!, blobs!) : null;
    perFile.push({ file, found: ownFirst(own, rest), ...(first ? { first } : {}) });
  }
  return mergeSuspects(perFile);
}

/** The landing log's oldest landings since green; a lookup that fails leaves the file without a first landing (its newest suspects stand). */
async function firstLookup(lookup: NonNullable<SuspectSearch["landedSince"]>, paths: Path[], since: SinceGreen): Promise<readonly LandedOn[]> {
  try {
    const found = await lookup(paths, since);
    return Array.isArray(found) ? found : [];
  } catch (err) {
    console.warn(`culprit finding: no first landing since green: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

/** The file's own landing (if any) and the newest others, one entry per landing and proposal, at most SUSPECTS_PER_FILE, newest first. */
function ownFirst(own: readonly LandedOn[], rest: readonly LandedOn[]): LandedOn[] {
  const key = landedKey;
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
