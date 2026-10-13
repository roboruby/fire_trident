import type { FailingTest, Id, LostTest, Path, Sha } from "@fire_trident/core";
import { RUN_DEPENDENT } from "./cache.ts";
import type { Loaded } from "./load.ts";
import { MAX_ERROR, testName, type RunReport } from "./report.ts";

/**
 * What certification owes: the tests a run must run and pass before `certified` may move again.
 *
 * - The baseline is the newest green run: every test file that ran in it, with the tests that
 *   passed in each (by name, duplicate names counted). A later run lost a test it no longer runs
 *   and passes (it is todo or skipped now, or not defined any more), and lost a file that did not
 *   run at all: the runner left it out (a package import, the size caps, no node:test), or it was
 *   deleted from trunk. A deletion counts as a loss because a green run included the file and
 *   nothing here knows whether a person approved removing it.
 * - A repair intent owes the failing tests it was declared for until a green run in which every one
 *   of them ran and passed, whether the intent is still open or already landed.
 *
 * A run that lost anything is red whatever its own tests say, so `certified` and the green mark stay
 * where they are and the repair loop is asked to bring the tests back. A test file no green run
 * included owes nothing until a repair intent is declared for it. A person accepts a loss by
 * withdrawing the repair intent declared for it: what that intent named as lost leaves the baseline
 * and every repair's obligations.
 */

/** Lost tests a result lists (in `lost`, and in `failing` as well). */
export const MAX_LOST = 50;
/** Characters of one file's passing test names the baseline keeps at most; past it, only their number. */
export const MAX_KEPT_CHARS = 256 * 1024;
/** Length of a result's `detail` when it lost tests. */
const MAX_DETAIL = 600;

/** One test file's passing tests in the baseline: their names (repeated for duplicates), or their number when the names are too long to keep. */
export type Kept = string[] | number;

/** The newest green run's tests (see the module comment). */
export interface Baseline {
  sha: Sha;
  files: Map<Path, Kept>;
}

/** One failing test a repair intent was declared for. */
export interface Owed {
  file: Path;
  /**
   * "test": the test passes. "suite": the suite passes, with every test in it. "file": the file
   * loads and every test in it passes (it failed to load, or one of its file-level hooks failed).
   */
  kind: "test" | "suite" | "file";
  /** The test's or suite's name (a suite's without " (suite)"). */
  name?: string;
}

/** A repair intent that still owes its tests. */
export interface OwedRepair {
  intentId: Id;
  /** The red commit it was declared on. */
  sha: Sha;
  owed: Owed[];
}

/** A lost test or file, with what the repair loop needs to fix it. */
export interface Lost extends LostTest {
  /** "test": the file ran and lost this test (or `count` tests whose names were not kept); "file": the file did not run. */
  scope: "test" | "file";
  count?: number;
  /** For a file that did not run: the file that kept it out (itself or a module it reaches); null when it was deleted from trunk. */
  via?: Path | null;
}

/** What a repair intent keeps of a loss, so that a person withdrawing the intent accepts it. */
export type LostKey = Pick<Lost, "file" | "name" | "scope" | "count">;

/** One test file's outcomes in a run. */
export interface FileRun {
  tests: Array<{ name: string; status: string }>;
  suites: Array<{ name: string; status: string }>;
}

/** One run's results per test file. */
export interface RunFiles {
  /** Test files that loaded and ran: their tests and suites (names as results keep them). */
  ran: Map<Path, FileRun>;
  /** Test files that ran but failed to load or were cut short by the run's limits: their own failure already makes the run red. */
  broken: Set<Path>;
  /** Test files the runner left out: why, and the file that kept each out. */
  leftOut: Map<Path, { reason: string; via: Path }>;
}

/** The trunk listing a run read: whether a path is on trunk, and whether the listing was cut short. */
export interface Listing {
  has(path: Path): boolean;
  truncated: boolean;
}

/** A status that fails a run, as summarize counts it: anything but pass, skipped and todo. */
function fails(status: string): boolean {
  return status !== "pass" && status !== "skipped" && status !== "todo";
}

/** Per-file results of a run (`report` null: nothing ran) and the test files it left out. */
export function runFiles(report: RunReport | null, loaded: Pick<Loaded, "unsupported" | "via"> | null): RunFiles {
  const out: RunFiles = { ran: new Map(), broken: new Set(), leftOut: new Map() };
  for (const u of loaded?.unsupported ?? []) out.leftOut.set(u.path, { reason: u.reason, via: loaded?.via.get(u.path) ?? u.path });
  if (!report) return out;
  const byFile = new Map<Path, FileRun & { cut: boolean }>();
  const of = (file: Path): FileRun & { cut: boolean } => {
    let f = byFile.get(file);
    if (!f) byFile.set(file, (f = { tests: [], suites: [], cut: false }));
    return f;
  };
  for (const t of Array.isArray(report.tests) ? report.tests : []) {
    const f = of(t.file);
    const status = String(t.status);
    f.tests.push({ name: testName(t.name), status });
    // Only a test that fails the run marks its file as cut short (the file is then red already): a
    // todo test's error is the repository's text, and must not let a green run skip what the file owes.
    if (fails(status) && RUN_DEPENDENT.test(t.error ?? "")) f.cut = true;
  }
  for (const s of Array.isArray(report.suites) ? report.suites : []) of(s.file).suites.push({ name: testName(s.name), status: String(s.status) });
  for (const meta of Array.isArray(report.files) ? report.files : []) {
    const f = byFile.get(meta.path);
    if (meta.loadError || f?.cut) out.broken.add(meta.path);
    else out.ran.set(meta.path, { tests: f?.tests ?? [], suites: f?.suites ?? [] });
  }
  return out;
}

/** The baseline a green run leaves: per test file that ran, the names of the tests that passed. */
export function baselineOf(sha: Sha, run: RunFiles): Baseline {
  const files = new Map<Path, Kept>();
  for (const [file, r] of run.ran) {
    const names = r.tests.filter((t) => t.status === "pass").map((t) => t.name).sort();
    files.set(file, JSON.stringify(names).length > MAX_KEPT_CHARS ? names.length : names);
  }
  return { sha, files };
}

/** A red result's failing tests as obligations (a file that failed to load, or a failed file-level hook, owes the whole file). */
export function owedOf(failing: readonly FailingTest[]): Owed[] {
  const out: Owed[] = [];
  const seen = new Set<string>();
  for (const f of failing) {
    if (!f.file) continue;
    const suite = f.name.endsWith(" (suite)") ? f.name.slice(0, -" (suite)".length) : null;
    const o: Owed =
      f.name === f.file || suite === "(file before hook)" || suite === "(file after hook)"
        ? { file: f.file, kind: "file" }
        : suite !== null
          ? { file: f.file, kind: "suite", name: suite }
          : { file: f.file, kind: "test", name: f.name };
    const k = `${o.file}\u0000${o.kind}\u0000${o.name ?? ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(o);
  }
  return out;
}

/** What a run lost against the baseline and the repairs' obligations (see the module comment), the baseline's first. */
export function findLost(p: { baseline: Baseline | null; repairs: readonly OwedRepair[]; run: RunFiles; listing: Listing }): Lost[] {
  const out: Lost[] = [];
  const seen = new Set<string>();
  const add = (l: Lost): void => {
    seen.add(keyOf(l));
    out.push(l);
  };
  const fileLost = (file: Path, since: Sha, repairIntentId?: Id): void => {
    if (seen.has(`${file}\u0000`)) return;
    const left = p.run.leftOut.get(file);
    const l: Lost = left
      ? { file, scope: "file", why: `did not run: ${left.reason}`, since, via: left.via }
      : p.listing.has(file)
        ? { file, scope: "file", why: "did not run", since }
        : p.listing.truncated
          ? { file, scope: "file", why: "not in the trunk listing, which was cut short", since }
          : { file, scope: "file", why: "deleted from trunk", since, via: null };
    if (repairIntentId) l.repairIntentId = repairIntentId;
    add(l);
  };

  const b = p.baseline;
  if (b) {
    for (const [file, kept] of b.files) {
      // A file that failed to load or was cut short is red already, and its failure names it.
      if (p.run.broken.has(file)) continue;
      const r = p.run.ran.get(file);
      if (!r) {
        fileLost(file, b.sha);
        continue;
      }
      if (typeof kept === "number") {
        const passed = r.tests.filter((t) => t.status === "pass").length;
        if (passed < kept) add({ file, scope: "test", count: kept - passed, why: `${kept - passed} of the ${kept} tests that passed here no longer pass (their names were too long to keep)`, since: b.sha });
        continue;
      }
      for (const [name, need] of tally(kept)) for (const why of shortfall(r, name, need)) add({ file, name, scope: "test", why, since: b.sha });
    }
  }

  for (const rep of p.repairs) {
    for (const o of rep.owed) {
      if (p.run.broken.has(o.file)) continue;
      const r = p.run.ran.get(o.file);
      if (!r) {
        fileLost(o.file, rep.sha, rep.intentId);
        continue;
      }
      const l: Lost = { file: o.file, scope: "test", why: "", since: rep.sha, repairIntentId: rep.intentId };
      if (o.kind !== "file" && o.name !== undefined) l.name = o.name;
      if (seen.has(keyOf(l))) continue;
      const why = unmet(o, r, b?.files.has(o.file) === true);
      if (why === null) continue;
      l.why = why;
      add(l);
    }
  }
  return out;
}

function keyOf(l: Pick<Lost, "file" | "name" | "scope">): string {
  return `${l.file}\u0000${l.scope === "file" ? "" : (l.name ?? "#")}`;
}

function tally(names: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const n of names) out.set(n, (out.get(n) ?? 0) + 1);
  return out;
}

/** One file's outcomes by name: each test name's statuses (duplicates kept), each suite's status. */
interface Index {
  tests: Map<string, string[]>;
  suites: Map<string, string>;
}

const INDEXES = new WeakMap<FileRun, Index>();

/** Index a file's outcomes once, so a file with many tests is not searched once per name. */
function indexOf(r: FileRun): Index {
  let i = INDEXES.get(r);
  if (!i) {
    i = { tests: new Map(), suites: new Map() };
    for (const t of r.tests) {
      const list = i.tests.get(t.name);
      if (list) list.push(t.status);
      else i.tests.set(t.name, [t.status]);
    }
    for (const s of r.suites) if (!i.suites.has(s.name)) i.suites.set(s.name, s.status);
    INDEXES.set(r, i);
  }
  return i;
}

/** Why each of `need` passing runs of `name` is missing from this file (a failing run of it is not lost: the run is red for it). */
function shortfall(r: FileRun, name: string, need: number): string[] {
  const same = indexOf(r).tests.get(name) ?? [];
  let missing = need - same.filter((s) => s === "pass").length;
  if (missing <= 0) return [];
  missing -= same.filter(fails).length;
  const out: string[] = [];
  for (const status of same) {
    if (missing <= 0) break;
    if (status === "todo" || status === "skipped") {
      out.push(`${status} now`);
      missing--;
    }
  }
  if (missing <= 0) return out;
  const why = absent(r, name);
  if (why !== null) for (; missing > 0; missing--) out.push(why);
  return out;
}

/** Why a test or suite that is not in the file did not run, or null when a failing parent explains it (its failure is named). */
function absent(r: FileRun, name: string): string | null {
  const index = indexOf(r);
  const parts = name.split(" > ");
  for (let i = parts.length - 1; i > 0; i--) {
    const parent = parts.slice(0, i).join(" > ");
    const suite = index.suites.get(parent);
    const statuses = index.tests.get(parent) ?? (suite !== undefined ? [suite] : null);
    if (!statuses) continue;
    if (statuses.some(fails)) return null;
    const idle = statuses.find((s) => s !== "pass");
    return idle === undefined ? "not defined any more" : `not run: ${parent} is ${idle} now`;
  }
  return "not defined any more";
}

/** Why a repair's obligation is not met in this file's run, or null when it is (or when the test still fails: the run is red for it). */
function unmet(o: Owed, r: FileRun, inBaseline: boolean): string | null {
  if (o.kind === "test") {
    const name = o.name ?? "";
    const same = indexOf(r).tests.get(name) ?? [];
    if (same.some((s) => s === "pass" || fails(s))) return null;
    const idle = same.find((s) => s === "todo" || s === "skipped");
    return idle ? `${idle} now` : absent(r, name);
  }
  if (o.kind === "suite") {
    const name = o.name ?? "";
    const suite = indexOf(r).suites.get(name);
    const under = r.tests.filter((t) => t.name.startsWith(`${name} > `));
    if (suite === "fail" || under.some((t) => fails(t.status))) return null;
    if (suite === undefined && under.length === 0) return absent(r, name);
    if (suite === "skipped") return "skipped now";
    if (under.length === 0) return "has no tests now";
    const idle = under.filter((t) => t.status !== "pass").length;
    return idle > 0 ? `${idle} of its ${under.length} tests ${idle === 1 ? "is" : "are"} todo or skipped now` : null;
  }
  // The file loads again. When a green run included it, the baseline owes its tests by name.
  if (inBaseline || r.tests.some((t) => fails(t.status))) return null;
  if (r.tests.length === 0) return "defines no tests now";
  const idle = r.tests.filter((t) => t.status !== "pass").length;
  return idle > 0 ? `${idle} of its ${r.tests.length} tests ${idle === 1 ? "is" : "are"} todo or skipped now` : null;
}

/** Accept losses a person approved: drop them from the baseline. Returns whether anything changed. */
export function acceptInBaseline(b: Baseline, keys: readonly LostKey[]): boolean {
  let changed = false;
  for (const k of keys) {
    const kept = b.files.get(k.file);
    if (kept === undefined) continue;
    if (k.scope === "file") {
      b.files.delete(k.file);
      changed = true;
    } else if (typeof kept === "number") {
      b.files.set(k.file, Math.max(0, kept - (k.count ?? 1)));
      changed = true;
    } else if (k.name !== undefined && kept.includes(k.name)) {
      kept.splice(kept.indexOf(k.name), 1);
      changed = true;
    }
  }
  return changed;
}

/** Accept losses a person approved: drop what they cover from a repair's obligations (a whole file, or one test or suite). */
export function acceptInOwed(owed: readonly Owed[], keys: readonly LostKey[]): Owed[] {
  return owed.filter((o) => !keys.some((k) => k.file === o.file && (k.scope === "file" || k.name === undefined || k.name === o.name)));
}

/** Where a lost test last ran, in words: "it passed on certified abc1234", "repair int_x was declared for it on trunk def5678". */
export function lostOrigin(l: LostTest): string {
  const short = l.since.slice(0, 7);
  return l.repairIntentId ? `repair ${l.repairIntentId} was declared for it on trunk ${short}` : `it ${l.name === undefined ? "ran" : "passed"} on certified ${short}`;
}

/** A lost test as results publish it: without what only the repair loop needs. */
export function publicLost(l: Lost): LostTest {
  const out: LostTest = { file: l.file, why: l.why, since: l.since };
  if (l.name !== undefined) out.name = l.name;
  if (l.repairIntentId) out.repairIntentId = l.repairIntentId;
  return out;
}

/** A lost test as `failing` lists it: its name (the file's when the whole file is lost) and the reason as the error. */
export function lostAsFailing(l: LostTest): FailingTest {
  const error = `lost: ${l.why} (${lostOrigin(l)})`;
  return { name: l.name ?? l.file, file: l.file, error: error.length > MAX_ERROR ? `${error.slice(0, MAX_ERROR - 1)}…` : error };
}

/** The plain reason a result that lost tests gives (its `detail`): what was lost, and why it was owed. */
export function lostDetail(lost: readonly Lost[], anyFailing: boolean): string {
  const parts: string[] = [];
  const fromGreen = lost.filter((l) => !l.repairIntentId);
  const fromRepairs = lost.filter((l) => l.repairIntentId);
  if (fromGreen.length > 0) parts.push(`${amount(fromGreen)} that passed on certified ${fromGreen[0]!.since.slice(0, 7)} did not run: ${listOf(fromGreen)}`);
  if (fromRepairs.length > 0) {
    const ids = [...new Set(fromRepairs.map((l) => l.repairIntentId!))];
    const which = ids.length === 1 ? `repair ${ids[0]} was` : `repairs ${ids.slice(0, 3).join(", ")}${ids.length > 3 ? " and others" : ""} were`;
    parts.push(`${amount(fromRepairs)} ${which} declared for did not run: ${listOf(fromRepairs)}`);
  }
  const text = `${anyFailing ? "Not certified: " : "Every test that ran passed, but "}${parts.join("; ")}`;
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL - 1)}…` : text;
}

function amount(list: readonly Lost[]): string {
  const files = list.filter((l) => l.scope === "file").length;
  const tests = list.reduce((n, l) => n + (l.scope === "file" ? 0 : (l.count ?? 1)), 0);
  const t = `${tests} test${tests === 1 ? "" : "s"}`;
  const f = `${files} test file${files === 1 ? "" : "s"}`;
  return tests > 0 && files > 0 ? `${t} and ${f}` : files > 0 ? f : t;
}

function listOf(list: readonly Lost[]): string {
  const shown = list.slice(0, 4).map((l) => {
    const why = l.why.length > 90 ? `${l.why.slice(0, 89)}…` : l.why;
    return `${l.name !== undefined ? `${l.file} > ${l.name}` : l.file} (${why})`;
  });
  return `${shown.join(", ")}${list.length > 4 ? ` and ${list.length - 4} more` : ""}`;
}
