import type { Certification, Evidence, FailingTest, FileVersion, Id, Path, Proposal, ReviewTestFailing, ReviewTestOnTrunk, ReviewTestsRun, Sha } from "@fire_trident/core";
import { sha256Hex } from "../trunk/digest.ts";
import { maskSecrets } from "../trunk/mask.ts";
import { RUN_DEPENDENT, fileKeyText, mergeResults, splitReport, type FileResult } from "./cache.ts";
import { MODULE_FILE } from "./compile.ts";
import { DEFAULT_CAPS, load, testFiles, type CompileMemo, type IndexedFile, type Loaded } from "./load.ts";
import { RUNNER_VERSION, buildPlan, closureOf, type Plan } from "./plan.ts";
import type { PrelandReader } from "./preland.ts";
import { summarize, testName, type RunReport } from "./report.ts";

/**
 * Tests before approval. A person reviewing an escalated change (any rule that sends one to a person: danger patterns,
 * protected paths, merge locks, a model that could not review it, a goal conflict) used to see no test result: trunk
 * certification runs after landing, and tests before landing (preland.ts, FT_PRELAND) cover only the changes a colony
 * asks for, for a few files and a short time. Here, every escalated change gets the colony's tests run on it while it
 * waits: its files are laid over the trunk index at its base (an inline change's texts from the colony, any other's
 * from its workspace), every test file runs in the Dynamic Worker certification uses (no network, no env, CPU and
 * wall-clock limits), and the review card leads with the result. Test files whose import closure holds none of the
 * files the change writes keep the result certification stored for them under the same key (cache.ts), as a
 * certification run reuses them; the rest run with the change.
 *
 * Each failing test is set against the change's base: the result certification stored for that file at the base (its
 * key there), else the base commit's own certification (its failing tests by name). It passes there (the change broke
 * it), fails there too, is new with the change, did not finish within the run, or has nothing there to compare with.
 *
 * Runs are asynchronous, so escalation is never delayed: the escalation asks for one (escalated()), at most
 * REVIEW_TESTS_AT_ONCE go at once in a colony and the others wait in order (at most REVIEW_TESTS_QUEUE). Each is bounded
 * by REVIEW_TESTS_MS; a person waits for the change anyway, so the bound is far longer than tests before landing get.
 * The result is recorded on the proposal (`evidence.reviewTests`), so the human decision and the lineage note of an
 * approved change carry it. It fails open: no node:test tests, the run's limits, a time-out, a base that can no longer
 * be read, or certification off in the colony record "not run" with the reason, and the change waits for its person as
 * before. A person can run it again (POST /colonies/:id/proposals/:pid/tests, `ft review --retest`).
 */

/** Wall time of one run, from its start to its result. */
export const REVIEW_TESTS_MS = 60_000;
/** Runs going at once in one colony; the others wait in order. */
export const REVIEW_TESTS_AT_ONCE = 2;
/** Runs waiting at most in one colony: past that a change is recorded as not run, and a person can ask again later. */
export const REVIEW_TESTS_QUEUE = 32;
/** Failing tests a result lists (the counts cover them all). */
export const REVIEW_TESTS_LISTED = 10;
/** Paths read at the change's base at most, when trunk moved after it. */
const BASE_PATHS = 3_000;
/** Below this much time left, the test Worker is not started. */
const MIN_RUN_MS = 250;
/** Time kept back from the run's budget for its report. */
const REPORT_MS = 3_000;
/** The length of a test's name, a path and an error's first line on the card. */
const NAME_CHARS = 200;
const PATH_CHARS = 300;
const ERROR_CHARS = 240;
/** Failing tests the lead sentence names. */
const NAMED = 3;
/** As certification: above this many characters of modules, test files share one module copy. */
const ISOLATE_MAX_CHARS = 6 * 1024 * 1024;
/** Why a recorded run that no longer goes did not finish. */
const CUT_SHORT = "its run was cut short before it finished (the colony restarted); run it again";

/** The trunk writer's reads a run makes (TrunkDO). */
export interface ReviewTestsTrunk {
  certifySnapshot(p?: { maxFiles?: number }): Promise<{ trunkSha: Sha; files: IndexedFile[]; truncated: boolean }>;
  readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>>;
  baseBlobs?(baseSha: Sha, paths: Path[]): Promise<FileVersion[]>;
}

/** What a run uses of the colony's certifier (Certifier.sealedRuns). */
export interface SealedRuns {
  /** Compiled modules by path and blob, shared with certification. */
  memo: CompileMemo;
  /** Run one plan in certification's test Worker within `timeoutMs`. */
  run(plan: Plan, timeoutMs: number): Promise<RunReport>;
  /** Certification's stored results for test files, by the key of what each reaches (exact matches only). */
  results(keys: ReadonlyMap<Path, string>): Map<Path, FileResult>;
  /** The colony's per-test limit (its certification policy), part of each file's key. */
  testTimeoutMs(): number;
  /** Keep the compile memo within its size after a run. */
  trim?(): void;
}

/** What the colony gives the runs (ColonyDO). */
export interface ReviewTestsHost {
  /** Why tests cannot run in this colony (certification off, no test runner), as a clause; null when they can. */
  off(): string | null;
  trunk(): ReviewTestsTrunk;
  sandbox(): SealedRuns;
  /** The certification of a commit, or null. */
  certification(sha: Sha): Pick<Certification, "trunkSha" | "status" | "counts" | "failing" | "lost"> | null;
  /** A proposal as stored, with an inline change's contents. */
  proposal(id: Id): Proposal | null;
  /** Reads a change's new blobs as text. */
  reader(p: Proposal): PrelandReader;
  /**
   * Record `run` as the proposal's `evidence.reviewTests`, when it is still escalated and (unless `replaces` is null) its
   * recorded run is `replaces`. True when written.
   */
  save(id: Id, run: ReviewTestsRun, replaces: string | null): boolean;
  now?(): number;
}

/** What asking for a run again answers: the queued run, or why none was started (404: no such proposal; 409: anything else). */
export type RetestAnswer = { started: true; run: ReviewTestsRun } | { started: false; status: 404 | 409; reason: string; run?: ReviewTestsRun };

/** A run's outcome before its time and its sentence are known. */
type Verdict = Omit<ReviewTestsRun, "id" | "by" | "at">;

const LATE = new Error("late");

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const short = (sha: string | undefined): string => (typeof sha === "string" ? sha.slice(0, 7) : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Text on one line, cut to `n` characters. */
function oneLine(s: unknown, n: number): string {
  const flat = String(s ?? "").replace(/\s+/g, " ").trim();
  return flat.length > n ? `${flat.slice(0, n - 1)}…` : flat;
}

/** The first line of an error that says something, cut, with what looks like a secret masked. */
function firstLine(error: string | undefined): string | undefined {
  const line = (error ?? "").split("\n").map((l) => l.trim()).find((l) => l !== "");
  return line ? maskSecrets(oneLine(line, ERROR_CHARS)) : undefined;
}

/** `p`, or a rejection with `error` once `ms` pass first. */
function withTimeout<T>(p: Promise<T>, ms: number, error: Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(error), Math.max(0, ms));
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

/** Resolves once `p` settles or `ms` pass, whichever is first (its timer cleared either way). */
function settledWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, ms));
    const done = (): void => {
      clearTimeout(timer);
      resolve();
    };
    p.then(done, done);
  });
}

function notRun(reason: string, extra: Partial<Verdict> = {}): Verdict {
  return { ...extra, status: "notrun", reason };
}

/** Files a test run may load, as the trunk index lists them for certification (TrunkDO.certifySnapshot). */
function loadable(path: Path): boolean {
  return MODULE_FILE.test(path) && !/(^|\/)node_modules\//.test(path) && !/(^|\/)\./.test(path);
}

// ---------------------------------------------------------------------------
// Sentences (pure)

/** How the failing tests did on trunk, as clauses: "1 failing here that passes on trunk", "2 fail on trunk too". */
export function onTrunkClauses(on: ReviewTestsRun["onTrunk"]): string[] {
  const n = (k: ReviewTestOnTrunk): number => count(on?.[k]);
  const out: string[] = [];
  if (n("passes") > 0) out.push(`${n("passes")} failing here that ${n("passes") === 1 ? "passes" : "pass"} on trunk`);
  if (n("fails") > 0) out.push(`${n("fails")} ${n("fails") === 1 ? "fails" : "fail"} on trunk too`);
  if (n("new") > 0) out.push(`${n("new")} ${n("new") === 1 ? "is" : "are"} new with this change`);
  if (n("unfinished") > 0) out.push(`${n("unfinished")} did not finish within the run`);
  if (n("unknown") > 0) out.push(`${n("unknown")} with no result on trunk to compare with`);
  return out;
}

/** "433/434 passed", with the skipped and todo tests named when there are any. */
function countsText(r: Pick<ReviewTestsRun, "tests" | "passed" | "skipped" | "todo">): string {
  const parts = [`${count(r.passed)}/${count(r.tests)} passed`];
  if (count(r.skipped) > 0) parts.push(`${count(r.skipped)} skipped`);
  if (count(r.todo) > 0) parts.push(`${count(r.todo)} todo`);
  return parts.join(", ");
}

/**
 * The sentence a review card leads with: "Tests on this change: 433/434 passed, 1 failed ("subtracts"). 1 failing here
 * that passes on trunk.", "Tests on this change: not run: <reason>.", or that it waits or runs. `ahead`: runs waiting
 * before a queued one.
 */
export function reviewTestsText(r: Pick<ReviewTestsRun, "status"> & Partial<ReviewTestsRun>, ahead = 0): string {
  const head = "Tests on this change";
  if (r.status === "queued") return `${head}: waiting to run${ahead > 0 ? ` (${plural(ahead, "run")} ahead of it in this colony)` : ""}.`;
  if (r.status === "running") return `${head}: running on its base${r.baseSha ? ` ${short(r.baseSha)}` : ""}.`;
  if (r.status !== "ran") return `${head}: not run: ${(r.reason ?? "no reason was recorded").replace(/[.\s]+$/, "")}.`;
  const failing = Array.isArray(r.failing) ? r.failing : [];
  const failed = Math.max(count(r.failed), failing.length);
  if (failed === 0) return `${head}: ${countsText(r)}.`;
  const names = failing.slice(0, NAMED).map((f) => `"${f.name}"`);
  const more = failed > names.length ? `${names.length > 0 ? " and " : ""}${failed - names.length} more` : "";
  const clauses = onTrunkClauses(r.onTrunk);
  return `${head}: ${countsText(r)}, ${failed} failed (${names.join(", ")}${more}).${clauses.length > 0 ? ` ${clauses.join("; ")}.` : ""}`;
}

/** The result in a few words, for the decision a person makes on the change ("433/434 passed, 1 failed, 1 failing here that passes on trunk"). */
export function reviewTestsLine(r: ReviewTestsRun): string {
  if (r.status === "ran") {
    const failed = Math.max(count(r.failed), Array.isArray(r.failing) ? r.failing.length : 0);
    return [`${countsText(r)}${failed > 0 ? `, ${failed} failed` : ""}`, ...onTrunkClauses(r.onTrunk)].join(", ");
  }
  if (r.status === "notrun") return `not run, ${(r.reason ?? "no reason was recorded").replace(/[.\s]+$/, "")}`;
  return "not finished when the change was decided";
}

/** A run with its sentence. */
function withText(r: ReviewTestsRun, ahead = 0): ReviewTestsRun {
  return { ...r, text: reviewTestsText(r, ahead) };
}

// ---------------------------------------------------------------------------
// Against the base (pure)

/** A failing test of the run against the base: its file's stored result there, else the base commit's certification. */
export function compareFailing(
  f: FailingTest,
  base: { tests: ReadonlySet<Path>; results: ReadonlyMap<Path, FileResult>; cert: Pick<Certification, "status" | "failing"> | null },
): ReviewTestOnTrunk {
  if (RUN_DEPENDENT.test(f.error ?? "")) return "unfinished";
  const r = base.results.get(f.file);
  if (r) {
    // A test file that fails to load is named after itself (report.ts summarize).
    if (f.name === testName(f.file) && !r.tests.some((t) => testName(t.name) === f.name)) return r.loadError !== null ? "fails" : "passes";
    const suite = / \(suite\)$/.test(f.name) ? f.name.replace(/ \(suite\)$/, "") : null;
    if (suite !== null) {
      const s = (Array.isArray(r.suites) ? r.suites : []).find((x) => testName(x.name) === suite);
      return !s ? "new" : s.status === "fail" && s.error ? "fails" : "passes";
    }
    const t = r.tests.find((x) => testName(x.name) === f.name);
    if (!t) return "new";
    return t.status === "pass" || t.status === "skipped" || t.status === "todo" ? "passes" : "fails";
  }
  if (!base.tests.has(f.file)) return "new";
  // No stored result for the file there: the base commit's own certification names its failing tests.
  const cert = base.cert;
  if (cert && (cert.status === "green" || cert.status === "red") && (cert.failing ?? []).some((x) => x.file === f.file && x.name === f.name)) return "fails";
  return "unknown";
}

/** Failing tests listed first: the ones the change broke, then new ones, then the rest. */
const ORDER: Record<ReviewTestOnTrunk, number> = { passes: 0, new: 1, unknown: 2, unfinished: 3, fails: 4 };

/** Why nothing can run with the change: no test files, none written for node:test, or none this runner can load. */
function nothingReason(index: readonly IndexedFile[], after: Loaded): string {
  const tests = testFiles(index);
  if (tests.length === 0) return "there are no test files (*.test.ts or *.test.js) with the change";
  if (after.unsupported.length > 0 && after.unsupported.every((u) => u.reason === "does not import node:test")) return `no test file imports node:test (${plural(tests.length, "test file")})`;
  const why = after.unsupported.slice(0, 2).map((u) => `${oneLine(u.path, 120)} ${oneLine(u.reason, 160)}`);
  return `no test file can run in the sandbox${why.length > 0 ? `: ${why.join("; ")}` : ""}`;
}

/** The trunk index at a change's base: the current one, or (trunk moved after it) each listed path read there; a sentence when it cannot be read. */
async function indexAtBase(trunk: ReviewTestsTrunk, snap: { trunkSha: Sha; files: IndexedFile[] }, at: Sha, written: readonly Path[]): Promise<IndexedFile[] | string> {
  if (at === snap.trunkSha) return snap.files;
  if (!trunk.baseBlobs) return "the trunk writer cannot read the change's base commit";
  const listed = new Map(snap.files.map((f) => [f.path, f]));
  const paths = [...new Set([...listed.keys(), ...written.filter(loadable)])];
  if (paths.length > BASE_PATHS) return `trunk moved since the change's base, and its ${paths.length} files are too many to read there`;
  const versions = await trunk.baseBlobs(at, paths);
  const index: IndexedFile[] = [];
  for (const v of Array.isArray(versions) ? versions : []) {
    if (!v || typeof v.path !== "string" || typeof v.blob !== "string" || v.blob === "") continue;
    const now = listed.get(v.path);
    index.push({ path: v.path, blob: v.blob, size: now && now.blob === v.blob ? now.size : 0 });
  }
  if (index.length === 0 && snap.files.length > 0) return `the change's base commit ${short(at)} can no longer be read`;
  return index;
}

// ---------------------------------------------------------------------------
// Runs

/** One colony's tests before approval (see the module comment). */
export class ReviewTests {
  /** Runs waiting, in order. */
  private readonly waiting: Array<{ proposalId: Id; runId: string }> = [];
  /** Runs going, by proposal. */
  private readonly going = new Map<Id, string>();
  /** Escalations whose run is asked for once the write that escalated them is done. */
  private readonly asking = new Set<Id>();
  private seq = 0;
  private readonly ms: number;
  private readonly atOnce: number;
  private readonly queueMax: number;

  constructor(
    private readonly host: ReviewTestsHost,
    opts: { ms?: number; atOnce?: number; queue?: number } = {},
  ) {
    this.ms = opts.ms ?? REVIEW_TESTS_MS;
    this.atOnce = Math.max(1, opts.atOnce ?? REVIEW_TESTS_AT_ONCE);
    this.queueMax = Math.max(0, opts.queue ?? REVIEW_TESTS_QUEUE);
  }

  private now(): number {
    return this.host.now ? this.host.now() : Date.now();
  }

  /** Runs going now. */
  get running(): number {
    return this.going.size;
  }

  /** Runs waiting now. */
  get queued(): number {
    return this.waiting.length;
  }

  private busy(id: Id): boolean {
    return this.going.has(id) || this.asking.has(id) || this.waiting.some((w) => w.proposalId === id);
  }

  /**
   * A proposal was escalated to a person: ask for a run of the colony's tests on it, once the write that escalated it is
   * done. Nothing when tests cannot run in the colony, a run for it is already asked for, or the same change already ran
   * (a change sent to a person again, as after a merge lock, keeps its result). Cheap and synchronous; never throws.
   */
  escalated(p: Pick<Proposal, "id" | "headSha" | "evidence">): void {
    try {
      const done = p.evidence?.reviewTests;
      if (done && done.status === "ran" && done.headSha === p.headSha) return;
      if (this.busy(p.id) || this.host.off() !== null) return;
      this.asking.add(p.id);
      queueMicrotask(() => {
        this.asking.delete(p.id);
        try {
          const cur = this.host.proposal(p.id);
          if (!cur || cur.status !== "escalated" || this.busy(cur.id) || this.host.off() !== null) return;
          this.enqueue(cur, "escalation");
        } catch (err) {
          console.warn(`tests before approval of ${p.id} not asked for: ${errorText(err)}`);
        }
      });
    } catch (err) {
      console.warn(`tests before approval of ${p.id} not asked for: ${errorText(err)}`);
    }
  }

  /** A person asked for the change's tests to run again (Run again): the queued run, or why none started. */
  request(proposalId: Id, by: string): RetestAnswer {
    const p = this.host.proposal(proposalId);
    if (!p) return { started: false, status: 404, reason: `unknown proposal ${oneLine(proposalId, 80)}` };
    if (p.status !== "escalated") return { started: false, status: 409, reason: `${p.id} is ${p.status}, not waiting for a person: tests before approval run only on a change in the review queue` };
    const off = this.host.off();
    if (off !== null) return { started: false, status: 409, reason: `Tests cannot run in this colony: ${off}. Turn certification on to test escalated changes.` };
    if (this.busy(p.id)) {
      const view = this.view(p);
      return { started: false, status: 409, reason: `The tests of ${p.id} are already waiting or running; the review queue shows their result when they end.`, ...(view ? { run: view } : {}) };
    }
    return this.enqueue(p, oneLine(by, 200) || "api");
  }

  /** Record a new run as queued (it replaces any earlier one) and start it when a slot is free. */
  private enqueue(p: Proposal, by: string): RetestAnswer {
    const now = this.now();
    const run: ReviewTestsRun = { id: `rtr_${now.toString(36)}${(++this.seq).toString(36)}`, status: "queued", by, at: now, headSha: p.headSha, baseSha: p.baseSha };
    if (this.waiting.length >= this.queueMax) {
      const reason = `${plural(this.waiting.length, "other escalated change")} already waited for a test run in this colony; run it again once they end`;
      const full = withText({ ...run, status: "notrun", reason, finishedAt: now });
      this.host.save(p.id, full, null);
      return { started: false, status: 409, reason: `Tests on this change: not run: ${reason}.`, run: full };
    }
    if (!this.host.save(p.id, run, null)) return { started: false, status: 409, reason: `${p.id} no longer waits for a person` };
    this.waiting.push({ proposalId: p.id, runId: run.id });
    this.pump();
    return { started: true, run: this.view({ ...p, evidence: { ...p.evidence, reviewTests: run } }) ?? withText(run) };
  }

  /** Start waiting runs while slots are free. A slot is held until its run ends (or twice the bound), so no more than atOnce go at once. */
  private pump(): void {
    while (this.going.size < this.atOnce && this.waiting.length > 0) {
      const next = this.waiting.shift()!;
      this.going.set(next.proposalId, next.runId);
      const work = this.runOne(next.proposalId, next.runId).catch((err: unknown) => console.warn(`tests before approval of ${next.proposalId} failed: ${errorText(err)}`));
      void settledWithin(work, this.ms * 2).then(() => {
        if (this.going.get(next.proposalId) === next.runId) this.going.delete(next.proposalId);
        this.pump();
      });
    }
  }

  /** One run: the change as it is now, if it still waits for a person under this run; its result recorded. */
  private async runOne(proposalId: Id, runId: string): Promise<void> {
    const p = this.host.proposal(proposalId);
    const queued = p?.evidence?.reviewTests;
    if (!p || p.status !== "escalated" || !queued || queued.id !== runId) return;
    const start = this.now();
    let verdict: Verdict;
    try {
      verdict = await withTimeout(this.execute(p, start + this.ms), this.ms + 1_000, LATE);
    } catch (err) {
      const msg = errorText(err);
      // The test Worker's own limit (Certifier.run) is this run's time too.
      if (err === LATE || /exceeded its \d+ s limit|ran out of time/i.test(msg)) verdict = notRun(`the tests took longer than ${Math.round(this.ms / 1000)} s`, { baseSha: p.baseSha });
      else if (/\bcpu\b/i.test(msg)) verdict = notRun("the run used up the CPU time the sandbox allows", { baseSha: p.baseSha });
      else verdict = notRun(`the test run failed: ${oneLine(msg, 200).replace(/[.\s]+$/, "")}`, { baseSha: p.baseSha });
    } finally {
      try {
        this.host.sandbox().trim?.();
      } catch {
        // Trimming the memo only keeps it small.
      }
    }
    const end = this.now();
    const run = withText({ ...queued, ...verdict, finishedAt: end, ms: Math.max(0, Math.round(end - start)) });
    this.host.save(proposalId, run, runId);
  }

  /** The run itself, within `deadline`. Throws on a trunk, read or runner problem (runOne records it as not run). */
  private async execute(p: Proposal, deadline: number): Promise<Verdict> {
    const sandbox = this.host.sandbox();
    const trunk = this.host.trunk();
    const at = p.baseSha;
    const base = { baseSha: at };
    const writes = (Array.isArray(p.writeSet) ? p.writeSet : []).filter((w) => w && typeof w.path === "string");
    const snap = await trunk.certifySnapshot({});
    const index = await indexAtBase(trunk, snap, at, writes.map((w) => w.path));
    if (typeof index === "string") return notRun(index, base);

    // The change's files a test can load, laid over the base.
    const mine = writes.filter((w) => loadable(w.path));
    const wanted = [...new Set(mine.flatMap((w) => (w.blob === null ? [] : [w.blob])))];
    const texts = wanted.length > 0 ? await this.host.reader(p)(wanted) : new Map<Sha, string | null>();
    const own = new Map<Sha, string>();
    const overlay = new Map(index.map((f) => [f.path, f]));
    for (const w of mine) {
      if (w.blob === null) {
        overlay.delete(w.path);
        continue;
      }
      const text = texts.get(w.blob);
      if (typeof text !== "string") return notRun(`${oneLine(w.path, PATH_CHARS)} could not be read from the change as text`, base);
      own.set(w.blob, text);
      overlay.set(w.path, { path: w.path, blob: w.blob, size: new TextEncoder().encode(text).length });
    }
    const fromTrunk = (blobs: Sha[]): Promise<Record<Sha, string | null>> => trunk.readBlobs(blobs);
    const withChange = async (blobs: Sha[]): Promise<Record<Sha, string | null>> => {
      const rest = blobs.filter((b) => !own.has(b));
      const out: Record<Sha, string | null> = rest.length > 0 ? { ...(await trunk.readBlobs(rest)) } : {};
      for (const b of blobs) if (own.has(b)) out[b] = own.get(b)!;
      return out;
    };
    const after = await load([...overlay.values()], withChange, DEFAULT_CAPS, sandbox.memo);
    if (after.tests.length === 0) return notRun(nothingReason([...overlay.values()], after), base);
    const before = await load(index, fromTrunk, DEFAULT_CAPS, sandbox.memo);

    // Test files that load nothing the change writes keep certification's result for them; the others run with it.
    const timeout = sandbox.testTimeoutMs();
    const keyOf = (t: Path, l: Loaded): Promise<string> => sha256Hex(fileKeyText(t, closureOf(t, l.modules), l.blobs, RUNNER_VERSION, timeout));
    const keys = new Map<Path, string>();
    for (const t of after.tests) keys.set(t, await keyOf(t, after));
    const results = new Map<Path, FileResult>(sandbox.results(keys));
    const toRun = after.tests.filter((t) => !results.has(t));
    if (toRun.length > 0) {
      const left = deadline - this.now();
      if (left < MIN_RUN_MS) throw LATE;
      const config = { testTimeoutMs: timeout, budgetMs: Math.max(MIN_RUN_MS, left - REPORT_MS) };
      let plan = buildPlan({ tests: toRun, modules: after.modules, config });
      if (plan.bytes > ISOLATE_MAX_CHARS) plan = buildPlan({ tests: toRun, modules: after.modules, config, isolate: false });
      const report = await sandbox.run(plan, left);
      for (const [path, r] of splitReport(report, toRun, true)) results.set(path, r);
    }
    const s = summarize(mergeResults(after.tests, results, RUNNER_VERSION, 0));
    if (s.status === "skipped") return notRun(s.detail ?? "the test files define no tests", base);

    // Each failing test against the base.
    const baseKeys = new Map<Path, string>();
    for (const t of before.tests) baseKeys.set(t, await keyOf(t, before));
    const cert = this.host.certification(at);
    const against = { tests: new Set(before.tests), results: sandbox.results(baseKeys), cert: cert && cert.trunkSha === at ? cert : null };
    const unreported = toRun.filter((t) => !results.has(t));
    const failing: ReviewTestFailing[] = [
      ...s.failing.map((f) => ({ f, on: compareFailing(f, against) })),
      ...unreported.map((file) => ({ f: { file, name: testName(file), error: "the run did not report this file" }, on: "unfinished" as const })),
    ]
      .map(({ f, on }): ReviewTestFailing => {
        const error = firstLine(f.error);
        return { file: oneLine(f.file, PATH_CHARS), name: maskSecrets(oneLine(f.name, NAME_CHARS)), ...(error ? { error } : {}), onTrunk: on };
      })
      .sort((a, b) => ORDER[a.onTrunk] - ORDER[b.onTrunk]);
    const onTrunk: Partial<Record<ReviewTestOnTrunk, number>> = {};
    for (const f of failing) onTrunk[f.onTrunk] = (onTrunk[f.onTrunk] ?? 0) + 1;
    const k = s.counts;
    const out: Verdict = {
      ...base,
      status: "ran",
      files: after.tests.length,
      ranFiles: toRun.length,
      ...(after.unsupported.length > 0 ? { unsupported: after.unsupported.length } : {}),
      tests: k.tests + unreported.length,
      passed: k.pass,
      failed: k.fail + k.cancelled + unreported.length,
      ...(k.skipped > 0 ? { skipped: k.skipped } : {}),
      ...(k.todo > 0 ? { todo: k.todo } : {}),
      ...(failing.length > 0 ? { failing: failing.slice(0, REVIEW_TESTS_LISTED), onTrunk } : {}),
    };
    if (against.cert && (against.cert.status === "green" || against.cert.status === "red")) {
      const c = against.cert.counts;
      out.trunk = {
        sha: at,
        status: against.cert.status,
        tests: c?.tests ?? 0,
        passed: c?.pass ?? 0,
        failing: (c?.fail ?? 0) + (c?.cancelled ?? 0) + (Array.isArray(against.cert.lost) ? against.cert.lost.length : 0),
      };
    }
    return out;
  }

  /**
   * A proposal's run as the review queue shows it, with its sentence: the recorded one, running or waiting while this
   * object runs it, cut short when it no longer does (the colony restarted), and, when none was recorded, why not.
   */
  view(p: Pick<Proposal, "id" | "status" | "evidence">): ReviewTestsRun | null {
    const run = p.evidence?.reviewTests;
    if (run && typeof run === "object" && typeof run.id === "string") {
      if (run.status !== "queued" && run.status !== "running") return withText(run);
      if (this.going.get(p.id) === run.id) return withText({ ...run, status: "running" });
      const at = this.waiting.findIndex((w) => w.proposalId === p.id && w.runId === run.id);
      if (at >= 0) return withText({ ...run, status: "queued" }, at);
      return withText({ ...run, status: "notrun", reason: CUT_SHORT });
    }
    if (p.status !== "escalated") return null;
    const now = this.now();
    if (this.asking.has(p.id)) return withText({ id: "", status: "queued", by: "escalation", at: now });
    const off = this.host.off();
    return withText({ id: "", status: "notrun", by: "escalation", at: now, reason: off ?? "no run was asked for it (it waited for a person before escalated changes were tested); run it again" });
  }

  /**
   * A person decided the change: the line the decision records of its run, and, when the run was still waiting or going,
   * the evidence that records it as not finished (it is dropped). Nothing when no run was ever recorded for it.
   */
  decided(p: Proposal): { line: string | null; evidence?: Evidence } {
    const stored = p.evidence?.reviewTests;
    if (!stored || typeof stored !== "object" || typeof stored.id !== "string") return { line: null };
    if (stored.status !== "queued" && stored.status !== "running") return { line: reviewTestsLine(stored) };
    const view = this.view(p);
    for (let i = this.waiting.length - 1; i >= 0; i--) if (this.waiting[i]!.proposalId === p.id) this.waiting.splice(i, 1);
    const reason = view?.status === "notrun" ? (view.reason ?? CUT_SHORT) : "the change was decided before its tests finished";
    const run = withText({ ...stored, status: "notrun", reason, finishedAt: this.now() });
    return { line: reviewTestsLine(run), evidence: { ...p.evidence, reviewTests: run } };
  }
}
