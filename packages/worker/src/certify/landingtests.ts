import type { Certification, FileVersion, Id, IntentSpend, Landing, LandingTests, LineageNote, Path, Sha, TestAuthorGroup, TestAuthors, TestsAt } from "@fire_trident/core";
import { proofPath, spentOnIntent, testDelta, testsRow, type FileOutcomes } from "@fire_trident/core";
import { sha256Hex } from "../trunk/digest.ts";
import { fileKeyText, type FileResult } from "./cache.ts";
import { MODULE_FILE, TEST_FILE } from "./compile.ts";
import { DEFAULT_CAPS, load, type CompileMemo, type IndexedFile, type Loaded } from "./load.ts";
import { RUNNER_VERSION, closureOf } from "./plan.ts";
import { testName } from "./report.ts";
import type { TestFileLineage, TestLineageQuery } from "./testlineage.ts";

/**
 * A landing's test row (GET /api/colonies/:id/landings/:ref/tests), computed when a card asks for it, never at landing.
 *
 * Certification keeps, per certified commit, its status and counts and the failing tests by name (`certifications`), and,
 * per test file, every test's name and outcome under the key of what the file reaches (`certify_files`, cache.ts): it
 * keeps no list of the tests that passed on a commit. So the row reads:
 *
 * - Where: the landing and its note from the trunk writer, and each certified commit's place on trunk's chain
 *   (TrunkDO.commitOrder). The certified commit that includes the landing is the first green result at or after its
 *   commit; the base is the result for the commit it was applied on (its parent), or the nearest earlier one (then it
 *   reads "at <sha>, before base"). With no green result yet it is pending, and says why (trunk red, certification off,
 *   no run yet); a colony whose tests this platform cannot run (none on trunk, none written for node:test, or none it can
 *   load, as with Hono's) reads as having none.
 * - Lost and new tests: both commits' trees are read as certification reads them (load.ts, through the compile memo
 *   certification runs share, so a tree it ran costs no reads), each test file's key is computed as certification
 *   computes it, and the stored results under those keys give the names (core/testdelta.ts testDelta). A file whose
 *   results are no longer kept is counted as not compared.
 * - Whose tests: each test file at the certified commit, by its changes in the trunk writer's landing log and their notes
 *   (certify/testlineage.ts): inherited from the repository, added or edited by agents with no person's approval, or
 *   edited only with a person's approval.
 * - What reaches it: certification's own import closures (plan.ts closureOf) at the certified commit, for the files the
 *   landing wrote: test files on trunk before it (an `earlier` one), test files it wrote itself, test files added later.
 *   With no earlier one, the card warns "No earlier test reaches this change".
 *
 * The cheap part (where, counts, proof, spend) is read every time. The rest is bounded (BASE_PATHS, REACH_WRITES,
 * REACH_TESTS, REACH_CLOSURE, the read caps of a certification run), runs at most TESTS_AT_ONCE at a time per colony and
 * is cached per landing and certified commit in `landing_tests`, so a card opened again costs a few indexed reads. A
 * read that takes longer than TESTS_MS answers the cheap part and says so; the work goes on and the next read has it.
 */

/** Version of the cached part: a cached answer of another version is computed again. */
export const TESTS_VERSION = 1;
/** How long a read waits for the part that reads trees, before it answers without it. */
export const TESTS_MS = 5_000;
/** Reads of trees running at once in one colony, and reads waiting for one at most (past that, the cheap part only). */
export const TESTS_AT_ONCE = 2;
export const TESTS_QUEUE = 16;
/** Paths read at an older commit at most (the trunk listing's loadable files). */
export const BASE_PATHS = 3_000;
/** Files of the landing the closure check looks for at most. */
export const REACH_WRITES = 64;
/** Test files whose closures the check follows at most, and modules of one closure it looks at. */
export const REACH_TESTS = 300;
export const REACH_CLOSURE = 400;
/** Test files of each kind a row names. */
const NAMED_FILES = 5;
/** Cached answers kept per colony. */
const KEEP_ROWS = 500;
/** Intents whose spend a row adds up at most. */
const PRICED_INTENTS = 20;

/** The trunk writer's reads a row makes (TrunkDO). */
export interface LandingTestsTrunk {
  landingNote(ref: string): Promise<{ landing: Landing; note: LineageNote | null } | null>;
  commitOrder(shas: Sha[]): Promise<Record<Sha, number>>;
  testLineage(q: TestLineageQuery): Promise<Record<Path, TestFileLineage>>;
  certifySnapshot(p?: { maxFiles?: number }): Promise<{ trunkSha: Sha; files: IndexedFile[]; truncated: boolean }>;
  baseBlobs(baseSha: Sha, paths: Path[]): Promise<FileVersion[]>;
  readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>>;
}

/** What the colony gives the row (ColonyDO). */
export interface LandingTestsHost {
  /** The colony's storage: certification's tables, and the row cache. */
  sql: SqlStorage;
  colonyId(): Id;
  trunk(): LandingTestsTrunk;
  /** The compile memo certification runs share (modules by path and blob), so a tree a run read is not read again. */
  memo(): CompileMemo | undefined;
  /** The colony's per-test limit (its certification policy): part of each test file's key. */
  testTimeoutMs(): number;
  /** Why certification does not run in this colony, as a clause, or null when it does. */
  off(): string | null;
  /** What the model calls counted for these intents cost (colony/intentspend.ts), or null when none were counted. */
  spend(intentIds: Id[]): { usd: number; calls: number; intents: number } | null;
}

/** One stored result, placed on trunk's chain. */
interface Placed {
  sha: Sha;
  status: string;
  seq: number;
  startedAt: number;
  finishedAt: number;
}

/** The part of a row that reads trees, cached per landing and certified commit. */
type Heavy = Pick<LandingTests, "lost" | "lostTests" | "added" | "unknownFiles" | "authors" | "reach" | "detail">;

const SCHEMA = "CREATE TABLE IF NOT EXISTS landing_tests (landing_id TEXT PRIMARY KEY, certified TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)";

const short = (sha: string): string => sha.slice(0, 7);
const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const plural = (n: number, word: string): string => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;

/** Why certification does not run in a colony (its state: the deployment's switch, the colony's policy, a test runner), as a clause; null when it does. */
export function certificationOff(s: { deployment: boolean; runner: boolean; policy: { enabled: boolean } }): string | null {
  if (!s.deployment) return "trunk certification is off on this deployment";
  if (!s.policy.enabled) return "trunk certification is off for this colony";
  return s.runner ? null : "this deployment has no test runner";
}

/** What the model calls counted for these intents cost (`report` reads one intent's spend), summed; null when none was counted for any. */
export function landingSpend(ids: readonly Id[], report: (id: Id) => IntentSpend): { usd: number; calls: number; intents: number } | null {
  let usd = 0;
  let calls = 0;
  let intents = 0;
  for (const id of ids) {
    const s = report(id);
    if (!spentOnIntent(s)) continue;
    usd += s.usd;
    calls += Object.values(s.calls ?? {}).reduce((a, b) => a + (typeof b === "number" && Number.isFinite(b) ? b : 0), 0);
    intents++;
  }
  return intents > 0 ? { usd: Math.round(usd * 1e8) / 1e8, calls, intents } : null;
}

/** A stored certification as the row reads it: status and counts, the failing ones counting lost tests too. */
export function testsAt(c: Pick<Certification, "trunkSha" | "status" | "counts" | "lost">): TestsAt {
  const k = c.counts;
  return {
    sha: c.trunkSha,
    status: c.status,
    pass: k?.pass ?? 0,
    tests: k?.tests ?? 0,
    failing: (k?.fail ?? 0) + (k?.cancelled ?? 0) + (Array.isArray(c.lost) ? c.lost.length : 0),
  };
}

/** Is this skipped result one with nothing to run (no test file, none for node:test, none this platform can load)? */
export function nothingToRun(c: Pick<Certification, "status" | "detail"> | null | undefined): boolean {
  return !!c && c.status === "skipped" && /^no test file/.test(c.detail ?? "");
}

/**
 * Where a landing sits among the stored results: the first green result at or after its commit, the first red one before
 * that, the first result with nothing to run, and the base (the result at its parent, else the nearest earlier one).
 */
export function placeLanding(results: readonly Placed[], landingSeq: number, parentSeq: number): { certified?: Placed; red?: Placed; skipped?: Placed; base?: Placed; before?: Placed } {
  const sorted = [...results].sort((a, b) => a.seq - b.seq || a.startedAt - b.startedAt);
  const after = sorted.filter((r) => r.seq >= landingSeq);
  const certified = after.find((r) => r.status === "green");
  const red = after.find((r) => r.status === "red" && (!certified || r.seq < certified.seq));
  const skipped = after.find((r) => r.status === "skipped");
  const earlier = sorted.filter((r) => r.seq <= parentSeq);
  const base = earlier.filter((r) => r.status === "green" || r.status === "red").at(-1);
  // The newest result of any kind before the landing: a run with nothing to run stops later runs until a test file comes.
  const before = earlier.at(-1);
  return { ...(certified ? { certified } : {}), ...(red ? { red } : {}), ...(skipped ? { skipped } : {}), ...(base ? { base } : {}), ...(before ? { before } : {}) };
}

/** Whose a test file is, from its changes (see TestAuthors): untouched, the agents', a person's, or unknown. */
export function originOf(l: TestFileLineage | undefined): "inherited" | "agents" | "person" | "unknown" {
  if (!l || !Array.isArray(l.changes)) return "unknown";
  if (l.changes.length === 0) return "inherited";
  if (l.changes.some((c) => c.by === "agent")) return "agents";
  if (l.more) return "unknown";
  return l.changes.every((c) => c.by === "person") ? "person" : "unknown";
}

/** Whose tests ran at the certified commit (originOf per file), with each file's test count where its results are kept. */
export function authorsOf(files: readonly Path[], lineage: Record<Path, TestFileLineage>, counts: ReadonlyMap<Path, number | null>): TestAuthors {
  const empty = (): TestAuthorGroup => ({ files: 0, tests: 0 });
  const groups = { inherited: empty(), agents: empty(), person: empty(), unknown: empty() };
  const names = { agents: new Set<string>(), person: new Set<string>() };
  let uncounted = 0;
  for (const file of files) {
    const l = Object.hasOwn(lineage, file) ? lineage[file] : undefined;
    const origin = originOf(l);
    const g = groups[origin];
    g.files++;
    const n = counts.get(file);
    if (typeof n === "number") g.tests += n;
    else uncounted++;
    if (origin === "agents" || origin === "person") {
      const want = origin === "agents" ? "agent" : "person";
      for (const c of l?.changes ?? []) if (c.by === want && c.name) names[origin].add(c.name);
    }
  }
  const named = (g: TestAuthorGroup, by: Set<string>): TestAuthorGroup => (by.size > 0 ? { ...g, by: [...by].sort().slice(0, 5) } : g);
  return {
    inherited: groups.inherited,
    agents: named(groups.agents, names.agents),
    person: named(groups.person, names.person),
    ...(groups.unknown.files > 0 ? { unknown: groups.unknown } : {}),
    ...(uncounted > 0 ? { uncounted } : {}),
  };
}

/**
 * The closure check (see TestReach): the test files of `loaded` whose closure reaches one of `wrote`, nearest first, and
 * which of them the landing wrote itself; the caller tells earlier from later ones. Bounded by REACH_TESTS and
 * REACH_CLOSURE; `bounded` says what was cut.
 */
export function reachingFiles(loaded: Pick<Loaded, "tests" | "modules" | "truncated">, wrote: ReadonlySet<Path>): { own: Path[]; others: Path[]; checked: number; bounded?: string } {
  const checked = loaded.tests.slice(0, REACH_TESTS);
  const found: Array<{ path: Path; at: number }> = [];
  for (const test of checked) {
    const at = closureOf(test, loaded.modules)
      .slice(0, REACH_CLOSURE)
      .findIndex((p) => wrote.has(p));
    if (at >= 0) found.push({ path: test, at });
  }
  found.sort((a, b) => a.at - b.at || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const cut: string[] = [];
  if (loaded.tests.length > checked.length) cut.push(`only the first ${REACH_TESTS} test files were checked`);
  if (loaded.truncated) cut.push("the tree was read only up to certification's read caps");
  return {
    own: found.filter((f) => wrote.has(f.path)).map((f) => f.path),
    others: found.filter((f) => !wrote.has(f.path)).map((f) => f.path),
    checked: checked.length,
    ...(cut.length > 0 ? { bounded: cut.join("; ") } : {}),
  };
}

/** The files a landing wrote that a test can load (its note's write sets, else its paths), at most REACH_WRITES; and whether more were left out. */
export function writtenCode(landing: Pick<Landing, "paths">, note: LineageNote | null): { paths: Set<Path>; more: boolean } {
  const all = new Set<Path>();
  for (const p of Array.isArray(note?.proposals) ? note.proposals : []) for (const w of Array.isArray(p?.writeSet) ? p.writeSet : []) if (w && typeof w.path === "string") all.add(w.path);
  if (all.size === 0) for (const path of Array.isArray(landing.paths) ? landing.paths : []) if (typeof path === "string") all.add(path);
  const code = [...all].filter((p) => MODULE_FILE.test(p)).sort();
  return { paths: new Set(code.slice(0, REACH_WRITES)), more: code.length > REACH_WRITES };
}

/** One compiled module as the memo keeps it. */
type MemoEntry = Parameters<CompileMemo["set"]>[1];

/**
 * A compile memo that reads through to the one certification runs share and keeps what it compiles to itself: a card
 * reads older trees, and their modules must not push the ones the next run needs out of the shared memo.
 */
export class ReadThroughMemo extends Map<string, MemoEntry> {
  constructor(private readonly shared: CompileMemo | undefined) {
    super();
  }

  override has(key: string): boolean {
    return super.has(key) || this.shared?.has(key) === true;
  }

  override get(key: string): MemoEntry | undefined {
    return super.get(key) ?? this.shared?.get(key);
  }
}

/** Each runnable test file's key, as certification computes it (cache.ts fileKeyText): what it reaches, the runner and the per-test limit. */
export async function fileKeys(loaded: Pick<Loaded, "tests" | "modules" | "blobs">, testTimeoutMs: number): Promise<Map<Path, string>> {
  const keys = new Map<Path, string>();
  for (const t of loaded.tests) keys.set(t, await sha256Hex(fileKeyText(t, closureOf(t, loaded.modules), loaded.blobs, RUNNER_VERSION, testTimeoutMs)));
  return keys;
}

/** A small FIFO gate: at most `max` holders at once. */
class Slots {
  private held = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}

  get waiting(): number {
    return this.queue.length;
  }

  async take(): Promise<() => void> {
    if (this.held < this.max) this.held++;
    else await new Promise<void>((go) => this.queue.push(go));
    let done = false;
    return () => {
      if (done) return;
      done = true;
      const next = this.queue.shift();
      if (next) next();
      else this.held--;
    };
  }
}

/** One colony's landing test rows (see the module comment). */
export class LandingTestsReader {
  private readonly slots = new Slots(TESTS_AT_ONCE);
  private readonly inflight = new Map<string, Promise<Heavy>>();

  constructor(private readonly host: LandingTestsHost) {}

  /** The row of landing `ref` (a landing id or the trunk commit it made), or null when the trunk writer knows no such landing. */
  async read(ref: string): Promise<LandingTests | null> {
    const trunk = this.host.trunk();
    const found = await trunk.landingNote(ref);
    if (!found) return null;
    const { landing, note } = found;
    const intents = [...new Set([...(note?.proposals ?? []).map((p) => p?.intent?.id), ...(landing.intentIds ?? [])].filter((x): x is Id => typeof x === "string" && x !== ""))].slice(0, PRICED_INTENTS);
    const spend = intents.length > 0 ? this.host.spend(intents) : null;
    const out: LandingTests = {
      colonyId: this.host.colonyId(),
      landingId: landing.id,
      trunkSha: landing.trunkSha,
      baseSha: landing.parentSha,
      status: "pending",
      proof: note ? proofPath(note) : { rungs: [{ rung: "unknown", count: 1 }], text: "unknown: the landing has no lineage note" },
      ...(spend ? { spend } : {}),
      text: "",
    };
    const done = (t: LandingTests): LandingTests => ({ ...t, text: testsRow(t) });

    const results = this.results();
    let order: Record<Sha, number>;
    try {
      order = await trunk.commitOrder([...new Set([...results.map((r) => r.sha), landing.trunkSha, landing.parentSha])]);
    } catch (err) {
      // A trunk writer still on older code (for a moment after a deployment) has no such read.
      return done({ ...out, reason: `the trunk writer could not place its commit just now (${errorText(err).replace(/[.\s]+$/, "")}); ask again in a moment` });
    }
    const landingSeq = order[landing.trunkSha];
    if (typeof landingSeq !== "number") return done({ ...out, reason: "the trunk writer's log does not place its commit" });
    const parentSeq = order[landing.parentSha] ?? landingSeq - 1;
    const placed: Placed[] = results.flatMap((r) => (typeof order[r.sha] === "number" ? [{ ...r, seq: order[r.sha]! }] : []));
    const at = placeLanding(placed, landingSeq, parentSeq);
    const cert = (p: Placed | undefined): Certification | null => (p ? this.certification(p.sha) : null);
    const base = cert(at.base);
    if (base) out.base = { ...testsAt(base), exact: base.trunkSha === landing.parentSha };
    const red = cert(at.red);
    if (red) out.red = testsAt(red);

    const certified = cert(at.certified);
    if (!certified) {
      // A run with nothing to run, at or after it, or the newest before it when it brought no test file (no run follows one).
      const skipped = cert(at.skipped) ?? (at.before && !red && !(landing.paths ?? []).some((p) => TEST_FILE.test(p)) ? cert(at.before) : null);
      if (!red && nothingToRun(skipped)) return done({ ...out, status: "no-tests", reason: skipped!.detail! });
      const off = this.host.off();
      const reason = red ? `trunk is red at ${short(red.trunkSha)} (${out.red!.failing} of ${out.red!.tests} failing)` : (off ?? "no certification has run on a commit that includes it yet");
      return done({ ...out, reason });
    }
    out.status = "certified";
    out.certified = testsAt(certified);
    const key = `${TESTS_VERSION}:${certified.trunkSha}:${certified.finishedAt ?? 0}`;
    const cached = this.cached(landing.id, key);
    if (cached) return done({ ...out, ...cached });

    const work = this.heavy(key, landing, note, certified, base);
    let late: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      late = setTimeout(() => resolve(null), TESTS_MS);
    });
    try {
      const heavy = await Promise.race([work, timeout]);
      if (heavy) return done({ ...out, ...heavy });
      return done({ ...out, detail: `Reading the trees took longer than ${TESTS_MS / 1000} s, so lost tests, whose tests they are and what reaches the change are not shown yet: open the card again in a moment.` });
    } catch (err) {
      return done({ ...out, detail: `The tests at its base and at the certified commit could not be compared: ${errorText(err).replace(/[.\s]+$/, "")}.` });
    } finally {
      if (late !== undefined) clearTimeout(late);
    }
  }

  /** The tree-reading part for one landing and certified commit: one at a time per key, at most TESTS_AT_ONCE at once, cached when it ends. */
  private heavy(key: string, landing: Landing, note: LineageNote | null, certified: Certification, base: Certification | null): Promise<Heavy> {
    const id = `${landing.id}\u0000${key}`;
    const running = this.inflight.get(id);
    if (running) return running;
    if (this.slots.waiting >= TESTS_QUEUE) return Promise.reject(new Error("too many cards are being read in this colony just now; open it again in a moment"));
    const work = (async () => {
      const release = await this.slots.take();
      try {
        const { heavy, keep } = await this.compute(landing, note, certified, base);
        // A part that failed to read is asked again next time rather than kept.
        if (keep) this.store(landing.id, key, heavy);
        return heavy;
      } finally {
        release();
      }
    })();
    this.inflight.set(id, work);
    work.then(
      () => this.inflight.delete(id),
      () => this.inflight.delete(id),
    );
    return work;
  }

  /** Lost and new tests, whose tests they are, and what reaches the change (see the module comment); `keep` is false when a part could not be read. */
  private async compute(landing: Landing, note: LineageNote | null, certified: Certification, base: Certification | null): Promise<{ heavy: Heavy; keep: boolean }> {
    const trunk = this.host.trunk();
    const notes: string[] = [];
    let keep = true;
    const snap = await trunk.certifySnapshot({});
    const memo = new ReadThroughMemo(this.host.memo());
    const read = (blobs: Sha[]): Promise<Record<Sha, string | null>> => trunk.readBlobs(blobs);
    const after = await load(await this.indexAt(certified.trunkSha, snap), read, DEFAULT_CAPS, memo);
    const atAfter = await this.outcomes(after, null);
    const out: Heavy = {};

    if (base) {
      try {
        const before = await load(await this.indexAt(base.trunkSha, snap), read, DEFAULT_CAPS, memo);
        const d = testDelta(await this.outcomes(before, base), atAfter);
        out.lost = d.lost;
        if (d.lostTests.length > 0) out.lostTests = d.lostTests;
        if (d.added > 0) out.added = d.added;
        if (d.unknownFiles > 0) {
          out.unknownFiles = d.unknownFiles;
          notes.push(`${plural(d.unknownFiles, "test file")} could not be compared: certification no longer keeps ${d.unknownFiles === 1 ? "its" : "their"} results at one of the two commits.`);
        }
      } catch (err) {
        keep = false;
        notes.push(`The base ${short(base.trunkSha)} could not be read, so lost tests are not known: ${errorText(err).replace(/[.\s]+$/, "")}.`);
      }
    }

    // Whose tests ran at the certified commit.
    try {
      const lineage = after.tests.length > 0 ? await trunk.testLineage({ paths: after.tests, upTo: certified.trunkSha }) : {};
      const counts = new Map<Path, number | null>(after.tests.map((t): [Path, number | null] => [t, atAfter.get(t)?.tests?.length ?? null]));
      out.authors = authorsOf(after.tests, lineage, counts);
    } catch (err) {
      keep = false;
      notes.push(`Whose tests they are could not be read from the landing log: ${errorText(err).replace(/[.\s]+$/, "")}.`);
    }

    // What reaches the change: earlier test files, its own, later ones.
    const wrote = writtenCode(landing, note);
    if (wrote.paths.size === 0) out.reach = { earlier: 0, own: 0, later: 0, earlierFiles: [], ownFiles: [], checked: 0, none: "no-code" };
    else {
      const r = reachingFiles(after, wrote.paths);
      const before = r.others.length > 0 ? await trunk.baseBlobs(landing.parentSha, r.others) : [];
      const existed = new Set(before.filter((v) => v && typeof v.blob === "string" && v.blob !== "").map((v) => v.path));
      const earlier = r.others.filter((p) => existed.has(p));
      const cut = [r.bounded, wrote.more ? `only ${REACH_WRITES} of the files it wrote were looked for` : undefined].filter((x): x is string => !!x);
      out.reach = {
        earlier: earlier.length,
        own: r.own.length,
        later: r.others.length - earlier.length,
        earlierFiles: earlier.slice(0, NAMED_FILES),
        ownFiles: r.own.slice(0, NAMED_FILES),
        checked: r.checked,
        ...(cut.length > 0 ? { bounded: cut.join("; ") } : {}),
      };
    }
    if (notes.length > 0) out.detail = notes.join(" ");
    return { heavy: out, keep };
  }

  /** The trunk index at `sha` as certification lists it: the current one, or each listed file read at that commit. */
  private async indexAt(sha: Sha, snap: { trunkSha: Sha; files: IndexedFile[] }): Promise<IndexedFile[]> {
    if (sha === snap.trunkSha) return snap.files;
    if (snap.files.length > BASE_PATHS) throw new Error(`trunk lists ${plural(snap.files.length, "loadable file")}, too many to read at commit ${short(sha)} (at most ${BASE_PATHS})`);
    const listed = new Map(snap.files.map((f) => [f.path, f]));
    const versions = await this.host.trunk().baseBlobs(sha, [...listed.keys()]);
    const index: IndexedFile[] = [];
    for (const v of Array.isArray(versions) ? versions : []) {
      if (!v || typeof v.path !== "string" || typeof v.blob !== "string" || v.blob === "") continue;
      const now = listed.get(v.path);
      index.push({ path: v.path, blob: v.blob, size: now && now.blob === v.blob ? now.size : 0 });
    }
    if (index.length === 0 && snap.files.length > 0) throw new Error(`commit ${short(sha)} could not be read`);
    return index;
  }

  /**
   * Each test file's key (as certification computes it) and its stored results under that key (null when no longer kept).
   * A file the stored result of `cert` lists as failing to load ran no test there.
   */
  private async outcomes(loaded: Loaded, cert: Certification | null): Promise<Map<Path, FileOutcomes>> {
    const keys = await fileKeys(loaded, this.host.testTimeoutMs());
    const stored = this.fileResults([...keys.values()]);
    const unloaded = new Set((cert?.failing ?? []).filter((f) => f && f.name === f.file).map((f) => f.file));
    const out = new Map<Path, FileOutcomes>();
    for (const [path, key] of keys) {
      const r = stored.get(key);
      const tests = r && Array.isArray(r.tests) ? r.tests.map((t) => ({ name: testName(t.name), status: String(t.status) })) : unloaded.has(path) ? [] : null;
      out.set(path, { key, tests });
    }
    return out;
  }

  /** Stored per-file results by key (certify_files, cache.ts), read only: a card's read does not keep them longer. */
  private fileResults(keys: readonly string[]): Map<string, FileResult> {
    const out = new Map<string, FileResult>();
    if (keys.length === 0) return out;
    try {
      for (const r of this.host.sql.exec<{ key: string; data: string }>("SELECT key, data FROM certify_files WHERE key IN (SELECT value FROM json_each(?))", JSON.stringify(keys)).toArray()) {
        try {
          out.set(r.key, JSON.parse(r.data) as FileResult);
        } catch {
          // An unreadable row reads as not kept.
        }
      }
    } catch {
      // No certification table yet: nothing kept.
    }
    return out;
  }

  /** Every stored verdict (green, red, or nothing to run), as certification keeps them (at most its KEEP newest). */
  private results(): Array<Omit<Placed, "seq">> {
    try {
      return this.host.sql
        .exec<{ trunk_sha: string; status: string; started_at: number; finished_at: number | null }>(
          "SELECT trunk_sha, status, started_at, finished_at FROM certifications WHERE status IN ('green', 'red', 'skipped')",
        )
        .toArray()
        .map((r) => ({ sha: r.trunk_sha, status: r.status, startedAt: r.started_at, finishedAt: r.finished_at ?? 0 }));
    } catch {
      return [];
    }
  }

  /** One commit's stored result. */
  private certification(sha: Sha): Certification | null {
    try {
      const row = this.host.sql.exec<{ data: string }>("SELECT data FROM certifications WHERE trunk_sha = ?", sha).toArray()[0];
      return row ? (JSON.parse(row.data) as Certification) : null;
    } catch {
      return null;
    }
  }

  private cached(landingId: Id, key: string): Heavy | null {
    try {
      this.host.sql.exec(SCHEMA);
      const row = this.host.sql.exec<{ data: string }>("SELECT data FROM landing_tests WHERE landing_id = ? AND certified = ?", landingId, key).toArray()[0];
      return row ? (JSON.parse(row.data) as Heavy) : null;
    } catch {
      return null;
    }
  }

  private store(landingId: Id, key: string, heavy: Heavy): void {
    try {
      this.host.sql.exec(SCHEMA);
      this.host.sql.exec("INSERT OR REPLACE INTO landing_tests (landing_id, certified, at, data) VALUES (?, ?, ?, ?)", landingId, key, Date.now(), JSON.stringify(heavy));
      this.host.sql.exec("DELETE FROM landing_tests WHERE landing_id IN (SELECT landing_id FROM landing_tests ORDER BY at DESC LIMIT -1 OFFSET ?)", KEEP_ROWS);
    } catch (err) {
      console.warn(`landing tests: row for ${landingId} not cached: ${errorText(err)}`);
    }
  }
}
