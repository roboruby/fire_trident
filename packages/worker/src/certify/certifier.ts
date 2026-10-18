import type { Certification, CertificationStatus, ColonyEvent, FailingTest, FileVersion, FirstRed, Id, Landing, LineageNote, NoteCertification, Path, Proposal, Sha } from "@fire_trident/core";
import { FirstRedSearch } from "./bisect.ts";
import { PrelandChecks, prelandMatches, type PrelandOutcome, type PrelandReader } from "./preland.ts";
import type { SealedRuns } from "./reviewtests.ts";
import { TEST_FILE } from "./compile.ts";
import { SUSPECTS_MAX, SUSPECT_MS, capSuspects, findSuspects, markFirstRed, publicSuspect, type FoundSuspect, type LandedOn, type SinceGreen } from "./culprit.ts";
import { markIsolated } from "./isolate.ts";
import { DEFAULT_CAPS, load, testFiles, type CompileMemo, type IndexedFile, type Loaded } from "./load.ts";
import { RUNNER_FAILED, RUNNER_VERSION, buildPlan, closureOf, type Plan } from "./plan.ts";
import { DEFAULT_POLICY, isOpen, mergePolicy, repairAction, repairIntent, type CertifyPolicy, type RepairIntentInput, type RepairRow } from "./repair.ts";
import type { LandingRange, RangeQuery } from "./range.ts";
import { countsLine, isReport, readBounded, summarize, type RunReport } from "./report.ts";
import { fileKeyText, mergeResults, splitReport, type FileResult } from "./cache.ts";
import { CertifySchedule } from "./schedule.ts";
import { excludeFiles, excludeTests } from "./exclude.ts";
import { afterFailedStart } from "./startfail.ts";
import {
  MAX_LOST,
  acceptInBaseline,
  acceptInOwed,
  baselineOf,
  findLost,
  lostAsFailing,
  lostDetail,
  owedOf,
  publicLost,
  runFiles,
  type Baseline,
  type Kept,
  type Listing,
  type Lost,
  type LostKey,
  type Owed,
  type OwedRepair,
  type RunFiles,
} from "./owed.ts";

/**
 * Trunk certification: after a landing moves trunk, run the project's own tests on it in a
 * Dynamic Worker and record the result per commit. ColonyDO hosts it (CertifyHost); the work is
 * asynchronous and never on a landing's path: onLanding only marks trunk as moved.
 *
 * One run: read the trunk index from TrunkDO (one call), read the test files and the modules they
 * reach (by blob id, so the snapshot is one commit), transpile TypeScript, load every test file
 * into one Dynamic Worker with no network (globalOutbound: null) and a CPU and wall-clock limit,
 * and count the results the way `node --test` does. Green moves the colony's greenSha; red keeps
 * the last green, names the changes that most likely broke it when culprit finding is on
 * (culprit.ts), and may declare a repair intent. Results are recorded, published as `certify`
 * events (so replays show them), and added to the certified landing's lineage note.
 *
 * A run is green only when it also ran and passed everything it owes (owed.ts): the tests that
 * passed in the newest green run, and the tests each repair intent was declared for. A run that
 * lost any of them is red, names what it lost, and leaves `certified` where it is.
 */

/** The TrunkDO calls certification makes. */
export interface CertifyTrunk {
  certifySnapshot(p?: { maxFiles?: number }): Promise<{ trunkSha: Sha; landingId: Id | null; files: IndexedFile[]; truncated: boolean }>;
  readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>>;
  annotate(landingId: Id, patch: Record<string, unknown>): Promise<boolean>;
  /** Move the trunk repository's `certified` branch to a commit whose tests passed. */
  markCertified(sha: Sha): Promise<boolean>;
  /** Blob of each path at a commit (null when absent; all null for an unknown commit): culprit finding reads the last green commit. */
  baseBlobs?(baseSha: Sha, paths: Path[]): Promise<FileVersion[]>;
  /** The first red search (bisect.ts): the landings between the last green commit and the red one, and a landing's lineage note. */
  landingRange?(q: RangeQuery): Promise<LandingRange>;
  landingNote?(ref: string): Promise<{ landing: Landing; note: LineageNote | null } | null>;
}

/** What the colony gives the certifier. */
export interface CertifyHost {
  sql: SqlStorage;
  /** The deployment's switch (FT_TRUNK_TESTS = "on"). */
  enabled(): boolean;
  /** The Worker Loader binding, when the deployment has one. */
  loader(): WorkerLoader | undefined;
  trunk(): CertifyTrunk;
  publish(events: ColonyEvent | ColonyEvent[]): void;
  /** The colony exists (init ran). */
  exists(): boolean;
  greenSha(): Sha | null;
  setGreen(sha: Sha): void;
  /** Every repair intent (source "certify") with its status and creation time. */
  repairs(): RepairRow[];
  declare(input: RepairIntentInput): Promise<Id>;
  satisfy(intentId: Id, reason: string): Promise<void>;
  /** The spec context of the intents that wrote these files, when the colony grew from a spec. */
  specFor(paths: Path[]): { spec: string; label: string | null } | null;
  /** Culprit finding is on for this colony (FT_CULPRITS); absent means off. */
  culprits?(): boolean;
  /**
   * The latest landings that changed any of `paths` (at most three, newest first), from the colony's
   * per-path landing index, each with its proposal and intent and the blobs it wrote for those paths.
   * With `since`: the oldest landings since the last green commit that changed them (a few, oldest
   * first), from the colony's landing log; none when the log may no longer hold them all.
   */
  landedOn?(paths: Path[], since?: SinceGreen): Promise<LandedOn[]>;
  /** The colony's landing that made commit `sha`, or null (a commit FireTrident made itself, or one no longer kept). */
  landingOf?(sha: Sha): { landingId: Id; at: number } | null;
  /** The first red search is on for this colony (FT_BISECT); absent means off. */
  bisect?(): boolean;
  /** Rewrite an open repair intent's why (`edit` gives the new text, or null to leave it); false when nothing changed. */
  repairWhy?(intentId: Id, edit: (why: string) => string | null): boolean;
  /** Tests before landing are on for this colony (FT_PRELAND, preland.ts); absent means off. */
  preland?(): boolean;
  /**
   * The red brake (FT_RED_BRAKE, colony/redbrake.ts): each green or red verdict once it is recorded, with what a failing
   * test file loads at the red commit (its import closure, itself first; null when the run read no modules).
   */
  verdict?(cert: Certification, reach: ((file: Path) => Path[]) | null): void;
}

/**
 * The test Worker's compatibility date: recent enough for everything the runner uses (nodejs_compat:
 * assert, async_hooks, util), old enough for every runtime that hosts this Worker (local and test
 * runtimes lag the deployed one).
 */
export const RUNNER_COMPAT_DATE = "2026-08-01";
/** Above this many characters of modules, test files share one module copy instead of one each. */
const ISOLATE_MAX_CHARS = 6 * 1024 * 1024;
/** Results kept per colony. */
const KEEP = 500;
/** Failing tests a live event carries, and the length of each error there. */
const EVENT_FAILING = 10;
const EVENT_ERROR = 160;
/** Suspects a live event carries (culprit finding). */
const EVENT_SUSPECTS = 5;
/** Failing tests a lineage note carries. */
const NOTE_FAILING = 20;
/** CPU the test Worker may use per run at most (it also stops at the wall-clock limit). */
const MAX_CPU_MS = 30_000;
/** The largest report the test Worker may answer with, in bytes (counted as the body streams in). */
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
/** Bytes of a failed answer's body kept for the error message. */
const MAX_FAILED_BODY_BYTES = 1024;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS certifications (
    trunk_sha TEXT PRIMARY KEY, landing_id TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
    inputs TEXT, test_key TEXT, data TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS certifications_by_start ON certifications(started_at)",
  "CREATE TABLE IF NOT EXISTS certify_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  // Per test file results, keyed by what the file reaches (cache.ts).
  "CREATE TABLE IF NOT EXISTS certify_files (key TEXT PRIMARY KEY, path TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS certify_files_by_at ON certify_files(at)",
  // What later runs owe (owed.ts): the newest green run's passing tests per test file, and what each repair intent was declared for.
  "CREATE TABLE IF NOT EXISTS certify_baseline (path TEXT PRIMARY KEY, data TEXT NOT NULL)",
  `CREATE TABLE IF NOT EXISTS certify_repairs (
    intent_id TEXT PRIMARY KEY, trunk_sha TEXT NOT NULL, state TEXT NOT NULL, at INTEGER NOT NULL, owed TEXT NOT NULL, lost TEXT NOT NULL)`,
];
/** Repair records kept besides the ones still owed. */
const KEEP_REPAIRS = 200;
/** Losses a repair intent keeps, to accept when a person withdraws it. */
const MAX_ACCEPT = 2_000;
/** Per-file results kept per colony. */
const KEEP_FILES = 5_000;
/** Compiled modules kept in memory between runs (a run then reads only files that changed). */
const MEMO_ENTRIES = 1_500;

/** A stored result with the keys that decide whether a later run can reuse it. */
interface Stored {
  cert: Certification;
  inputs: string | null;
  testKey: string | null;
  /** Every test file lacked a node:test import (depends on the test files only). */
  foreign?: boolean;
}

/** What a run owes (owed.ts). */
interface Owing {
  baseline: Baseline | null;
  repairs: OwedRepair[];
}

/** What judging a run found: for recording it and for the repair loop. */
interface Judged {
  loaded: Loaded | null;
  run: RunFiles | null;
  /** The run's own failing tests (`cert.failing` adds the lost ones). */
  failing: FailingTest[];
  /** Everything it lost (a result lists at most MAX_LOST). */
  lost: Lost[];
  /** The trunk index the run read (the red commit's blobs, for culprit finding). */
  index?: readonly IndexedFile[];
  /** Culprit finding's suspects with their intents' whys (the repair intent names them). */
  suspects?: FoundSuspect[];
}

/** One repair intent's record (certify_repairs): what it owes until a green run proves it. */
interface RepairRecord {
  intentId: Id;
  /** The red commit it was declared on. */
  sha: Sha;
  /** pending: still owed; satisfied: a green run proved its tests; released: a person withdrew it. */
  state: "pending" | "satisfied" | "released";
  at: number;
  owed: Owed[];
  /** What it was declared for as lost: accepted when a person withdraws it. */
  lost: LostKey[];
}

function owes(o: Owing): boolean {
  return (o.baseline?.files.size ?? 0) > 0 || o.repairs.some((r) => r.owed.length > 0);
}

/** Hex SHA-256 of a string. */
async function digest(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function clip(s: string | undefined, n: number): string | undefined {
  return s === undefined ? undefined : s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** An error a run raised itself (its limits, its checks of the answer), as opposed to one from the runtime. */
class RunError extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
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

/** Runs and records trunk certifications for one colony (see the module comment). */
export class Certifier {
  private readonly schedule: CertifySchedule;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private forced = false;
  private policyCache: CertifyPolicy | null = null;
  private readonly memo: CompileMemo = new Map();
  /** The latest result said there is nothing to run (no test files, or none for node:test); null otherwise or unknown. */
  private nothingToRun: boolean | null = null;
  /** The first red search (FT_BISECT, bisect.ts): after a red result is recorded, the first commit its failing tests fail on. */
  private readonly firstRed: FirstRedSearch;
  /** Tests before landing (FT_PRELAND, preland.ts), made on first use. */
  private prelandChecks: PrelandChecks | null = null;

  constructor(private readonly host: CertifyHost) {
    this.ensureSchema();
    this.schedule = new CertifySchedule(DEFAULT_POLICY.minIntervalMs);
    this.firstRed = new FirstRedSearch({
      trunk: () => this.host.trunk(),
      run: (plan, timeoutMs) => this.run(plan, { ...this.policy(), timeoutMs }),
      limits: () => ({ testTimeoutMs: this.policy().testTimeoutMs, timeoutMs: this.policy().timeoutMs }),
      record: (sha, firstRed) => this.recordFirstRed(sha, firstRed),
      publish: (e) => this.host.publish(e),
      repairWhy: (intentId, edit) => this.host.repairWhy?.(intentId, edit) ?? false,
    });
  }

  private ensureSchema(): void {
    for (const stmt of SCHEMA) this.host.sql.exec(stmt);
  }

  /** The colony's policy (defaults until an operator changes it). */
  policy(): CertifyPolicy {
    if (this.policyCache) return this.policyCache;
    const raw = this.meta("policy");
    let p = DEFAULT_POLICY;
    if (raw) {
      const merged = mergePolicy(DEFAULT_POLICY, JSON.parse(raw) as unknown);
      if ("policy" in merged) p = merged.policy;
    }
    this.policyCache = p;
    return p;
  }

  /** Change the policy (partial). Turning certification on asks for a run of the current trunk. */
  setPolicy(patch: unknown): CertifyPolicy | { error: string } {
    const merged = mergePolicy(this.policy(), patch);
    if ("error" in merged) return merged;
    const was = this.policy().enabled;
    this.setMeta("policy", JSON.stringify(merged.policy));
    this.policyCache = merged.policy;
    this.schedule.minIntervalMs = merged.policy.minIntervalMs;
    if (!was && merged.policy.enabled) this.certifyNow();
    return merged.policy;
  }

  /** Is certification on for this colony (deployment switch, colony policy, and a test runner)? */
  active(): boolean {
    return this.host.enabled() && this.policy().enabled && this.host.loader() !== undefined;
  }

  /** A landing (or a FireTrident commit) moved trunk: certify the newest trunk soon. Cheap and synchronous. */
  landed(l: Pick<Landing, "trunkSha" | "at"> & { paths?: Path[] }): void {
    if (!this.active()) return;
    // Nothing to run before, and no test file came or went: nothing to run now either (no trunk reads).
    if (this.nothingToRun === null) {
      const last = this.latest();
      this.nothingToRun = !!last && last.cert.status === "skipped" && (last.foreign === true || (last.cert.detail ?? "").startsWith("no test files"));
    }
    if (this.nothingToRun && Array.isArray(l.paths) && !l.paths.some((p) => TEST_FILE.test(p))) return;
    const was = this.schedule.pending();
    if (!this.schedule.request(l.trunkSha ?? "", typeof l.at === "number" ? l.at : Date.now())) return;
    if (!was) this.setMeta("wanted", "1");
    this.kick();
  }

  /** Certify the current trunk now, even when it was certified before (an operator asked). */
  certifyNow(): { started: boolean; reason?: string } {
    if (!this.host.enabled()) return { started: false, reason: "trunk tests are off on this deployment (FT_TRUNK_TESTS)" };
    if (!this.policy().enabled) return { started: false, reason: "certification is off for this colony (policy)" };
    if (!this.host.loader()) return { started: false, reason: "no test runner on this deployment (Worker Loader binding)" };
    this.schedule.force();
    this.forced = true;
    this.setMeta("wanted", "1");
    this.kick();
    return { started: true };
  }

  /** After the object wakes: resume a run that was asked for and never finished. */
  resume(): void {
    if (this.meta("wanted") === null || !this.host.exists() || !this.active()) return;
    this.schedule.force();
    this.kick();
  }

  /** Running state for the API. */
  state(): { on: boolean; deployment: boolean; runner: boolean; policy: CertifyPolicy; running: boolean; pending: boolean; greenSha: Sha | null; latest: Certification | null } {
    return {
      on: this.active(),
      deployment: this.host.enabled(),
      runner: this.host.loader() !== undefined,
      policy: this.policy(),
      running: this.schedule.busy(),
      pending: this.schedule.pending(),
      greenSha: this.host.greenSha(),
      latest: this.latest()?.cert ?? null,
    };
  }

  /** The newest result (any status), for the snapshot. */
  latestCertification(): Certification | null {
    return this.latest()?.cert ?? null;
  }

  /** The compile memo runs share (modules by path and blob): a landing's test row (landingtests.ts) reads trees through it, so a tree a run read is not read again. */
  compileMemo(): CompileMemo {
    return this.memo;
  }

  /** Results, newest first. */
  list(limit = 50): Certification[] {
    const n = Math.max(1, Math.min(KEEP, Math.floor(limit) || 50));
    return this.host.sql
      .exec<{ data: string }>("SELECT data FROM certifications ORDER BY started_at DESC, rowid DESC LIMIT ?", n)
      .toArray()
      .map((r) => JSON.parse(r.data) as Certification);
  }

  /** One commit's result (a full sha, or a unique prefix of at least 7 characters). */
  get(sha: string): Certification | null {
    const clean = sha.toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(clean)) return null;
    const rows = this.host.sql.exec<{ data: string }>("SELECT data FROM certifications WHERE trunk_sha LIKE ? LIMIT 2", `${clean}%`).toArray();
    return rows.length === 1 ? (JSON.parse(rows[0]!.data) as Certification) : null;
  }

  /** The colony was erased: drop in-memory state and recreate the tables. */
  reset(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.schedule.reset();
    this.forced = false;
    this.policyCache = null;
    this.nothingToRun = null;
    this.memo.clear();
    this.firstRed.reset();
    this.prelandChecks = null;
    this.ensureSchema();
  }

  // -------------------------------------------------------------------------

  private kick(): void {
    if (this.timer !== null) return;
    this.schedule.minIntervalMs = this.policy().minIntervalMs;
    const step = this.schedule.next(Date.now());
    if (step.kind === "wait") {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.kick();
      }, step.ms);
      return;
    }
    if (step.kind !== "start") return;
    this.schedule.start(Date.now());
    this.deleteMeta("wanted");
    const forced = this.forced;
    this.forced = false;
    let sha: Sha | null = null;
    void this.runOnce(forced, (s) => {
      sha = s;
      this.schedule.certifying(s);
    })
      .catch((err: unknown) => console.warn(`certification failed: ${errorText(err)}`))
      .finally(() => {
        this.schedule.finish(sha);
        if (this.active()) this.kick();
      });
  }

  /** One run: certify trunk as it is now. */
  private async runOnce(forced: boolean, onSha: (sha: Sha) => void): Promise<void> {
    const policy = this.policy();
    const startedAt = Date.now();
    const trunk = this.host.trunk();
    let snap: Awaited<ReturnType<CertifyTrunk["certifySnapshot"]>>;
    try {
      snap = await trunk.certifySnapshot({});
    } catch (err) {
      console.warn(`certification: trunk index unavailable: ${errorText(err)}`);
      return;
    }
    const sha = snap.trunkSha;
    if (!sha) return;
    onSha(sha);
    const prior = this.stored(sha);
    if (prior && prior.cert.status !== "running" && !forced) return;
    const indexMs = Date.now() - startedAt;
    const base: Certification = { trunkSha: sha, status: "running", startedAt };
    if (snap.landingId) base.landingId = snap.landingId;
    const last = this.latest();
    // What earlier runs proved and repairs were declared for: a run missing any of it is red.
    const owing = this.owing();
    const onTrunk = new Set(snap.files.map((f) => f.path));
    const listing: Listing = { has: (p) => onTrunk.has(p), truncated: snap.truncated === true };

    const tests = testFiles(snap.files);
    if (tests.length === 0) return this.nothingRan(base, "no test files (*.test.ts or *.test.js)", null, last, false, owing, listing, null, snap.files);
    const testKey = await digest(tests.map((t) => `${t.path} ${t.blob}`).join("\n"));
    if (last && last.foreign && last.testKey === testKey && !owes(owing)) return this.skip(base, last.cert.detail ?? "no test file imports node:test", testKey, last, true);

    const t1 = Date.now();
    let loaded: Loaded;
    try {
      loaded = await load(snap.files, (blobs) => trunk.readBlobs(blobs), DEFAULT_CAPS, this.memo);
      for (const k of this.memo.keys()) {
        if (this.memo.size <= MEMO_ENTRIES) break;
        this.memo.delete(k);
      }
    } catch (err) {
      return this.finish({ ...base, status: "error", detail: `could not read trunk: ${errorText(err)}` }, null, testKey, null);
    }
    const loadMs = Date.now() - t1;
    // Test files the policy excludes (known runtime differences) are left out, like files the runner cannot run.
    excludeFiles(loaded, policy.excludeTests);
    if (loaded.tests.length === 0) {
      const foreign = loaded.unsupported.every((u) => u.reason === "does not import node:test");
      const detail = foreign ? `no test file imports node:test (${tests.length} test file${tests.length === 1 ? "" : "s"})` : `no test file can run here: ${loaded.unsupported.slice(0, 3).map((u) => `${u.path} ${u.reason}`).join("; ")}`;
      return this.nothingRan({ ...base, unsupported: loaded.unsupported.slice(0, 20) }, detail, testKey, last, foreign, owing, listing, loaded, snap.files);
    }
    // Each test file's key: what it reaches (paths and blob ids), the runner, the per-test limit.
    const keys = new Map<Path, string>();
    for (const t of loaded.tests) keys.set(t, await digest(fileKeyText(t, closureOf(t, loaded.modules), loaded.blobs, RUNNER_VERSION, policy.testTimeoutMs)));
    const inputs = await digest([...keys].map(([p, k]) => `${p} ${k}`).join("\n"));
    const common: Certification = { ...base, files: loaded.tests.length };
    if (loaded.unsupported.length > 0) common.unsupported = loaded.unsupported.slice(0, 20);

    // Test files whose inputs did not change keep their results (tests are deterministic by contract); only the others run.
    const cached = forced ? new Map<Path, FileResult>() : this.cachedFiles(keys);
    const toRun = loaded.tests.filter((t) => !cached.has(t));
    const results = new Map<Path, FileResult>(cached);
    let workerMs = 0;
    let runMs = 0;
    let modules: Certification["modules"];
    if (toRun.length > 0) {
      this.store({ cert: { ...common, status: "running" }, inputs: null, testKey });
      this.host.publish({ t: "certify", at: Date.now(), trunkSha: sha, status: "running", ...(base.landingId ? { landingId: base.landingId } : {}) });
      const config = { testTimeoutMs: policy.testTimeoutMs, budgetMs: Math.max(1_000, policy.timeoutMs - 3_000) };
      let plan: Plan = buildPlan({ tests: toRun, modules: loaded.modules, config });
      if (plan.bytes > ISOLATE_MAX_CHARS) plan = buildPlan({ tests: toRun, modules: loaded.modules, config, isolate: false });
      const t2 = Date.now();
      let report: RunReport;
      try {
        report = await this.run(plan, policy);
      } catch (err) {
        const msg = errorText(err);
        const detail = /cpu|exceeded/i.test(msg) ? `the test run used up its CPU or time limit: ${msg}` : `the test runner failed: ${msg}`;
        return this.finish({ ...common, status: "error", detail: clip(detail, 400)!, timing: { indexMs, loadMs, workerMs: Date.now() - t2 } }, inputs, testKey, null);
      }
      workerMs = Date.now() - t2;
      runMs = report.ms;
      modules = { count: Object.keys(plan.modules).length, chars: plan.bytes };
      for (const [path, r] of splitReport(report, toRun, true)) results.set(path, r);
      // Files that shared one module copy could leak state into each other: their results judge
      // this run, but they are not kept under one file's key for later runs to reuse.
      if (plan.isolated) this.storeFiles(splitReport(report, toRun), keys);
    }
    // Tests the policy excludes by name count as unsupported (exclude.ts).
    const merged = excludeTests(mergeResults(loaded.tests, results, RUNNER_VERSION, runMs), policy.excludeTests);
    const s = summarize(merged);
    const cert: Certification = { ...common, status: s.status, counts: s.counts, failing: s.failing, runMs, timing: { indexMs, loadMs, workerMs } };
    if (cached.size > 0) cert.cached = cached.size;
    if (modules) cert.modules = modules;
    if (s.detail) cert.detail = s.detail;
    // Tests that used an API certification does not support (vitest snapshots, module mocking): counted apart, never red.
    if (s.unsupported) cert.unsupportedTests = s.unsupported;
    const judged = this.judge(cert, runFiles(merged, loaded), owing, listing, loaded, snap.files);
    // Nothing ran: these are the results of an earlier run of the same tested files (named when its verdict was the same).
    if (toRun.length === 0 && !forced) {
      const same = this.byInputs(inputs);
      if (same && same.cert.status === cert.status) cert.reusedFrom = same.cert.reusedFrom ?? same.cert.trunkSha;
    }
    return this.finish(cert, inputs, testKey, judged);
  }

  /**
   * Load the plan into a Dynamic Worker and run it. A Worker that does not start because a module of the plan does not
   * compile starts again with that module failing the test files that load it (startfail.ts), within the same limit.
   */
  private async run(plan: Plan, policy: CertifyPolicy): Promise<RunReport> {
    const deadline = Date.now() + policy.timeoutMs;
    try {
      return await this.runIn(plan, policy);
    } catch (err) {
      // Errors the run raised itself, and the runtime's limits, say nothing about a module that does not compile.
      const loader = this.host.loader();
      const fromRuntime = loader !== undefined && !(err instanceof RunError) && !/cpu|exceeded|memory/i.test(errorText(err));
      const again = fromRuntime ? await afterFailedStart(plan, loader, { deadline, compatibilityDate: RUNNER_COMPAT_DATE, maxCpuMs: MAX_CPU_MS }) : null;
      if (!again) throw err;
      return this.runIn(again, { ...policy, timeoutMs: deadline - Date.now() });
    }
  }

  /** Load the plan into a Dynamic Worker and run it. */
  private async runIn(plan: Plan, policy: CertifyPolicy): Promise<RunReport> {
    const loader = this.host.loader();
    if (!loader) throw new RunError("no Worker Loader binding");
    const worker = loader.load({
      compatibilityDate: RUNNER_COMPAT_DATE,
      compatibilityFlags: ["nodejs_compat"],
      mainModule: plan.mainModule,
      modules: plan.modules as Record<string, WorkerLoaderModule>,
      globalOutbound: null,
      limits: { cpuMs: Math.min(MAX_CPU_MS, policy.timeoutMs) },
    });
    // One deadline covers the answer and its body. Code from the repository runs beside the harness
    // and can answer with a body that never ends or trickles, so the body is read as a bounded stream.
    const deadline = Date.now() + policy.timeoutMs;
    const late = `the test run exceeded its ${Math.round(policy.timeoutMs / 1000)} s limit`;
    const answer = worker.getEntrypoint().fetch("https://certify.invalid/run");
    let res: Response;
    try {
      res = await withTimeout(answer, policy.timeoutMs, late);
    } catch (err) {
      // An answer that comes after the deadline is dropped unread.
      answer.then((r) => r.body?.cancel()).catch(() => undefined);
      throw err;
    }
    if (!res.ok) {
      const head = await readBounded(res.body, MAX_FAILED_BODY_BYTES, deadline);
      throw new RunError(`the test Worker answered ${res.status}: ${head.text.slice(0, 300)}`);
    }
    // The answer is written by code from the repository: refuse one too large to parse safely here.
    const body = await readBounded(res.body, MAX_REPORT_BYTES, deadline);
    if (body.over === "time") throw new RunError(late);
    if (body.over === "size") throw new RunError(`the test Worker's report is over the ${MAX_REPORT_BYTES / 1024 / 1024} MB limit`);
    const report = JSON.parse(body.text) as unknown;
    if (!isReport(report)) throw new RunError("the test Worker answered without a report");
    // The first file's runner loads before any code from the repository runs: when it cannot start,
    // the runner itself is broken, which says nothing about the code (an error, not a red run).
    const first = report.files[0];
    if (first && typeof first.loadError === "string" && first.loadError.startsWith(RUNNER_FAILED)) throw new RunError(`it could not start: ${first.loadError.slice(RUNNER_FAILED.length)}`);
    return report;
  }

  /**
   * Do tests before landing cover a change that writes `paths` (FT_PRELAND, preland.ts): the colony's certification is
   * on, the flag covers the colony, and the policy's prelandPaths match one of the paths (any, when there are none)?
   */
  prelandCovers(paths: readonly Path[]): boolean {
    return this.host.preland?.() === true && this.active() && prelandMatches(this.policy().prelandPaths, paths);
  }

  /**
   * Tests before landing (preland.ts): the test files a change reaches, run on its base with its files laid over it (read
   * with `readNew`) in the same test Worker as run() uses, each judged against this colony's stored result for it on
   * trunk. Null when they do not cover the change (see prelandCovers); otherwise never throws.
   */
  async precheck(p: Proposal, readNew: PrelandReader): Promise<PrelandOutcome | null> {
    if (!this.prelandCovers((Array.isArray(p?.writeSet) ? p.writeSet : []).map((w) => w.path))) return null;
    this.prelandChecks ??= new PrelandChecks({
      trunk: () => this.host.trunk(),
      memo: this.memo,
      run: (plan, timeoutMs) => this.run(plan, { ...this.policy(), timeoutMs }),
      results: (keys) => this.cachedFiles(keys),
      testTimeoutMs: () => this.policy().testTimeoutMs,
    });
    try {
      return await this.prelandChecks.check(p, readNew);
    } finally {
      for (const k of this.memo.keys()) {
        if (this.memo.size <= MEMO_ENTRIES) break;
        this.memo.delete(k);
      }
    }
  }

  /**
   * Tests before approval (reviewtests.ts): the test Worker run() uses, this colony's stored per-file results (exact keys),
   * the compile memo and the per-test limit, for runs on escalated changes. Nothing those runs find is stored here.
   */
  sealedRuns(): SealedRuns {
    return {
      memo: this.memo,
      run: (plan, timeoutMs) => this.run(plan, { ...this.policy(), timeoutMs }),
      results: (keys) => this.cachedFiles(keys),
      testTimeoutMs: () => this.policy().testTimeoutMs,
      trim: () => {
        for (const k of this.memo.keys()) {
          if (this.memo.size <= MEMO_ENTRIES) break;
          this.memo.delete(k);
        }
      },
    };
  }

  /** Record a run that had nothing to judge. Published only when it changes what the colony shows. */
  private skip(base: Certification, detail: string, testKey: string | null, last: Stored | null, foreign = false): void {
    const cert: Certification = { ...base, status: "skipped", detail, finishedAt: Date.now() };
    cert.durationMs = cert.finishedAt! - cert.startedAt;
    const green = this.host.greenSha();
    if (green) cert.greenSha = green;
    const stored: Stored = { cert, inputs: null, testKey };
    if (foreign) stored.foreign = true;
    this.store(stored);
    if (!last || last.cert.status !== "skipped" || last.cert.detail !== detail) this.host.publish(this.event(cert));
  }

  /**
   * No test file ran (none on trunk, none written for node:test, or none the runner can run). That
   * judges nothing, unless the run owes tests (owed.ts): then they are lost and the run is red.
   */
  private async nothingRan(base: Certification, detail: string, testKey: string | null, last: Stored | null, foreign: boolean, owing: Owing, listing: Listing, loaded: Loaded | null, index: readonly IndexedFile[]): Promise<void> {
    if (owes(owing)) {
      const cert: Certification = { ...base, status: "skipped", files: 0, counts: { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 }, failing: [] };
      const judged = this.judge(cert, runFiles(null, loaded), owing, listing, loaded, index);
      if (judged.lost.length > 0) return this.finish(cert, null, testKey, judged);
    }
    this.skip(base, detail, testKey, last, foreign);
  }

  /** Hold a run against what it owes (owed.ts): a run that lost a test is red, whatever its own tests say. */
  private judge(cert: Certification, run: RunFiles, owing: Owing, listing: Listing, loaded: Loaded | null, index: readonly IndexedFile[]): Judged {
    const failing = cert.failing ?? [];
    const judged: Judged = { loaded, run, failing, lost: [], index };
    if (cert.status !== "green" && cert.status !== "red" && cert.status !== "skipped") return judged;
    judged.lost = findLost({ baseline: owing.baseline, repairs: owing.repairs, run, listing });
    if (judged.lost.length === 0) return judged;
    const listed = judged.lost.slice(0, MAX_LOST).map(publicLost);
    cert.status = "red";
    cert.lost = listed;
    cert.failing = [...failing, ...listed.map(lostAsFailing)];
    cert.detail = lostDetail(judged.lost, failing.length > 0);
    return judged;
  }

  /** Record a verdict (or a failed run): greenSha and what later runs owe, the event, the repair loop, the lineage note. */
  private async finish(cert: Certification, inputs: string | null, testKey: string | null, judged: Judged | null): Promise<void> {
    cert.finishedAt = Date.now();
    cert.durationMs = cert.finishedAt - cert.startedAt;
    if (cert.status === "green") {
      // Everything owed ran and passed: every repair's tests are proven, and this run is what later runs owe.
      if (judged?.run) this.recordGreen(cert.trunkSha, judged.run);
      this.host.setGreen(cert.trunkSha);
      // The `certified` branch follows green, so plain git can check out the last trunk whose tests passed.
      void this.host
        .trunk()
        .markCertified(cert.trunkSha)
        .catch((err: unknown) => console.warn(`certification: certified branch not moved: ${errorText(err)}`));
    }
    const green = this.host.greenSha();
    if (green) cert.greenSha = green;
    // Culprit finding (FT_CULPRITS): the changes that may have broken the failing tests, for the result and the repair intent.
    if (cert.status === "red" && judged) {
      const found = await this.suspects(cert, judged);
      if (found.length > 0) {
        judged.suspects = found;
        cert.suspects = found.map(publicSuspect);
      }
    }
    if (cert.status === "red" || cert.status === "green") {
      try {
        const repairId = await this.repair(cert, judged);
        if (repairId) cert.repairIntentId = repairId;
      } catch (err) {
        console.warn(`certification: repair loop failed: ${errorText(err)}`);
      }
    }
    this.store({ cert, inputs: cert.status === "error" ? null : inputs, testKey });
    this.host.publish(this.event(cert));
    // The red brake (FT_RED_BRAKE): the verdict, and what its failing test files load (the module graph this run read).
    if (cert.status === "green" || cert.status === "red") {
      try {
        const modules = judged?.loaded?.modules ?? null;
        this.host.verdict?.(cert, modules ? (file) => closureOf(file, modules) : null);
      } catch (err) {
        console.warn(`certification: red brake not told: ${errorText(err)}`);
      }
    }
    // First red search (FT_BISECT): once the red result is recorded, find the first commit its failing tests fail on, in the background (bisect.ts).
    try {
      if (cert.status === "red" && judged && this.host.bisect?.()) this.firstRed.request({ cert, failing: judged.failing, ...(judged.suspects ? { suspects: judged.suspects } : {}) });
    } catch (err) {
      console.warn(`certification: first red search not started: ${errorText(err)}`);
    }
    if (cert.landingId && (cert.status === "green" || cert.status === "red")) {
      const note: NoteCertification = { runner: "node:test in a Dynamic Worker (trunk certification)", status: cert.status, finishedAt: cert.finishedAt };
      if (cert.counts) note.counts = cert.counts;
      if (cert.failing) note.failing = cert.failing.slice(0, NOTE_FAILING).map((f) => ({ ...f, ...(f.error ? { error: clip(f.error, 200)! } : {}) }));
      if (cert.durationMs !== undefined) note.durationMs = cert.durationMs;
      if (cert.reusedFrom) note.reusedFrom = cert.reusedFrom;
      // Cheap: the note is rewritten in TrunkDO and goes out with its next notes flush, beside the landing cycles.
      void this.host
        .trunk()
        .annotate(cert.landingId, { certification: note })
        .catch((err: unknown) => console.warn(`certification: lineage note not updated: ${errorText(err)}`));
    }
  }

  /** The repair loop for one verdict (repair.ts decides). Returns the intent it declared, if any. */
  private async repair(cert: Certification, judged: Judged | null): Promise<Id | null> {
    const policy = this.policy();
    const action = repairAction(cert, this.host.repairs(), policy, Date.now());
    if (action.kind === "satisfy") {
      const reason = `satisfied: every test it was declared for passes on trunk ${cert.trunkSha.slice(0, 7)} (${countsLine(cert.counts)})`;
      for (const id of action.ids) await this.host.satisfy(id, reason);
      return null;
    }
    if (action.kind !== "declare") return null;
    const loaded = judged?.loaded ?? null;
    const lost = judged?.lost ?? [];
    const lostAt = new Map(lost.map((l) => [`${l.file}\u0000${l.name ?? ""}`, l]));
    const files = [...new Set((cert.failing ?? []).map((f) => f.file))];
    const spec = this.host.specFor(files);
    const input = repairIntent({
      cert,
      reach: (file) => (loaded ? closureOf(file, loaded.modules) : [file]),
      isTest: (p) => TEST_FILE.test(p),
      fixIn: (t) => fixIn(t, lostAt.get(`${t.file}\u0000${t.name ?? ""}`), loaded),
      lostTotal: lost.length,
      spec: spec?.spec ?? null,
      ...(spec?.label ? { sourceLabel: spec.label } : {}),
      ...(judged?.suspects ? { suspects: judged.suspects } : {}),
    });
    const id = await this.host.declare(input);
    // The repair counts only once the tests it was declared for run and pass (owed.ts).
    try {
      const owed = owedOf(judged?.failing ?? cert.failing ?? []);
      this.saveRecord({ intentId: id, sha: cert.trunkSha, state: "pending", at: Date.now(), owed, lost: lost.slice(0, MAX_ACCEPT).map(lostKey) });
    } catch (err) {
      console.warn(`certification: repair intent ${id} not recorded: ${errorText(err)}`);
    }
    return id;
  }

  /** A green run: every repair's tests are proven, and its passing tests become the baseline (a failure here keeps the older baseline, which this run passed). */
  private recordGreen(sha: Sha, run: RunFiles): void {
    try {
      this.host.sql.exec("UPDATE certify_repairs SET state = 'satisfied' WHERE state NOT IN ('satisfied', 'released')");
      this.setBaseline(baselineOf(sha, run));
    } catch (err) {
      console.warn(`certification: owed tests not recorded: ${errorText(err)}`);
    }
  }

  private event(cert: Certification): ColonyEvent {
    const e: Extract<ColonyEvent, { t: "certify" }> = { t: "certify", at: cert.finishedAt ?? Date.now(), trunkSha: cert.trunkSha, status: cert.status };
    if (cert.landingId) e.landingId = cert.landingId;
    if (cert.counts) e.counts = cert.counts;
    if (cert.failing && cert.failing.length > 0) {
      e.failing = cert.failing.slice(0, EVENT_FAILING).map((f): FailingTest => {
        const out: FailingTest = { name: f.name, file: f.file };
        if (f.error) out.error = clip(f.error, EVENT_ERROR)!;
        return out;
      });
    }
    if (cert.durationMs !== undefined) e.durationMs = cert.durationMs;
    if (cert.greenSha) e.greenSha = cert.greenSha;
    if (cert.detail) e.detail = cert.detail;
    if (cert.reusedFrom) e.reusedFrom = cert.reusedFrom;
    if (cert.unsupportedTests && cert.unsupportedTests.length > 0) e.unsupportedTests = cert.unsupportedTests.slice(0, EVENT_FAILING);
    // The first landing since green keeps its place when the event carries fewer suspects than the result.
    if (cert.suspects && cert.suspects.length > 0) e.suspects = capSuspects(cert.suspects, EVENT_SUSPECTS);
    return e;
  }

  /**
   * Culprit finding for a red result (culprit.ts): the changes that may have broken its failing tests,
   * from one TrunkDO call (the green commit's blobs) and the colony's landing index. Off unless the
   * colony turns it on (FT_CULPRITS). Bounded by SUSPECT_MS: a lookup that fails or takes longer
   * leaves the result without suspects, and certification goes on as before.
   */
  private async suspects(cert: Certification, judged: Judged): Promise<FoundSuspect[]> {
    const host = this.host;
    try {
      const trunk = host.trunk();
      if (!host.culprits?.() || !host.landedOn || !trunk.baseBlobs) return [];
      const greenSha = host.greenSha();
      let red: Map<Path, Sha> | null = null;
      const search = findSuspects({
        files: (cert.failing ?? []).map((f) => f.file),
        modules: judged.loaded?.modules ?? null,
        red: (path) => {
          red ??= new Map((judged.index ?? []).map((f) => [f.path, f.blob]));
          return red.get(path) ?? null;
        },
        green: greenSha && greenSha !== cert.trunkSha ? { sha: greenSha, landing: host.landingOf?.(greenSha) ?? null, startedAt: this.stored(greenSha)?.cert.startedAt ?? null } : null,
        // Called as methods: the trunk is a Durable Object stub.
        blobsAt: (sha, paths) => trunk.baseBlobs!(sha, paths),
        landedOn: (paths) => host.landedOn!(paths),
        landedSince: (paths, since) => host.landedOn!(paths, since),
      });
      return await withTimeout(search, SUSPECT_MS, `took longer than ${SUSPECT_MS} ms`);
    } catch (err) {
      console.warn(`certification: no suspects for ${cert.trunkSha.slice(0, 7)}: ${errorText(err)}`);
      return [];
    }
  }

  /** The first red search's answer (bisect.ts) on the stored red result of `sha`: the result as stored, or null when it is gone or no longer red. */
  private recordFirstRed(sha: Sha, firstRed: FirstRed): Certification | null {
    const s = this.stored(sha);
    if (!s || s.cert.status !== "red") return null;
    s.cert.firstRed = firstRed;
    // Culprit finding's suspect in the landing it found is marked `first-red` (the suspects were recorded before the search ended).
    if (firstRed.status === "found" && firstRed.landingId && Array.isArray(s.cert.suspects)) s.cert.suspects = markFirstRed(s.cert.suspects, firstRed.landingId);
    // Proposal isolation (isolate.ts): the proposal isolated inside that landing is marked `isolated`, within the suspects' cap.
    if (firstRed.status === "found" && firstRed.landingId && firstRed.isolated && Array.isArray(s.cert.suspects)) s.cert.suspects = capSuspects(markIsolated(s.cert.suspects, firstRed.landingId, firstRed.isolated), SUSPECTS_MAX);
    this.store(s);
    return s.cert;
  }

  // -------------------------------------------------------------------------
  // Storage

  private store(s: Stored): void {
    if (s.cert.status !== "running") this.nothingToRun = s.cert.status === "skipped" && (s.foreign === true || (s.cert.detail ?? "").startsWith("no test files"));
    const data = JSON.stringify({ ...s.cert, ...(s.foreign ? { foreign: true } : {}) });
    this.host.sql.exec(
      `INSERT INTO certifications (trunk_sha, landing_id, status, started_at, finished_at, inputs, test_key, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(trunk_sha) DO UPDATE SET landing_id = excluded.landing_id, status = excluded.status, started_at = excluded.started_at,
         finished_at = excluded.finished_at, inputs = excluded.inputs, test_key = excluded.test_key, data = excluded.data`,
      s.cert.trunkSha,
      s.cert.landingId ?? null,
      s.cert.status,
      s.cert.startedAt,
      s.cert.finishedAt ?? null,
      s.inputs,
      s.testKey,
      data,
    );
    this.host.sql.exec("DELETE FROM certifications WHERE trunk_sha IN (SELECT trunk_sha FROM certifications ORDER BY started_at DESC, rowid DESC LIMIT -1 OFFSET ?)", KEEP);
  }

  private row(where: string, ...args: SqlStorageValue[]): Stored | null {
    const r = this.host.sql
      .exec<{ data: string; inputs: string | null; test_key: string | null }>(`SELECT data, inputs, test_key FROM certifications ${where} LIMIT 1`, ...args)
      .toArray()[0];
    if (!r) return null;
    const parsed = JSON.parse(r.data) as Certification & { foreign?: boolean };
    const { foreign, ...cert } = parsed;
    const out: Stored = { cert, inputs: r.inputs, testKey: r.test_key };
    if (foreign) out.foreign = true;
    return out;
  }

  private stored(sha: Sha): Stored | null {
    return this.row("WHERE trunk_sha = ?", sha);
  }

  private latest(): Stored | null {
    return this.row("WHERE status != 'running' ORDER BY started_at DESC, rowid DESC");
  }

  private byInputs(inputs: string): Stored | null {
    return this.row("WHERE inputs = ? AND status IN ('green', 'red') ORDER BY started_at DESC", inputs);
  }

  /** Stored results for these test files (by their keys), refreshed so they are kept. */
  private cachedFiles(keys: ReadonlyMap<Path, string>): Map<Path, FileResult> {
    const out = new Map<Path, FileResult>();
    if (keys.size === 0) return out;
    const byKey = new Map([...keys].map(([path, key]) => [key, path]));
    const rows = this.host.sql
      .exec<{ key: string; data: string }>("SELECT key, data FROM certify_files WHERE key IN (SELECT value FROM json_each(?))", JSON.stringify([...byKey.keys()]))
      .toArray();
    for (const r of rows) {
      const path = byKey.get(r.key);
      if (path) out.set(path, JSON.parse(r.data) as FileResult);
    }
    if (rows.length > 0) this.host.sql.exec("UPDATE certify_files SET at = ? WHERE key IN (SELECT value FROM json_each(?))", Date.now(), JSON.stringify(rows.map((r) => r.key)));
    return out;
  }

  /** Keep these files' results under their keys (the newest KEEP_FILES are kept). */
  private storeFiles(results: ReadonlyMap<Path, FileResult>, keys: ReadonlyMap<Path, string>): void {
    const now = Date.now();
    for (const [path, r] of results) {
      const key = keys.get(path);
      if (key) this.host.sql.exec("INSERT OR REPLACE INTO certify_files (key, path, at, data) VALUES (?, ?, ?, ?)", key, path, now, JSON.stringify(r));
    }
    this.host.sql.exec("DELETE FROM certify_files WHERE key IN (SELECT key FROM certify_files ORDER BY at DESC LIMIT -1 OFFSET ?)", KEEP_FILES);
  }

  /** What a run owes now (owed.ts), after the repair records are brought up to date. Unreadable records owe nothing rather than stop certification. */
  private owing(): Owing {
    try {
      this.reconcile();
    } catch (err) {
      console.warn(`certification: repair records not updated: ${errorText(err)}`);
    }
    try {
      return { baseline: this.baseline(), repairs: this.records(true).map((r) => ({ intentId: r.intentId, sha: r.sha, owed: r.owed })) };
    } catch (err) {
      console.warn(`certification: owed tests unreadable: ${errorText(err)}`);
      return { baseline: null, repairs: [] };
    }
  }

  /**
   * Bring the repair records up to date with the colony's repair intents. One withdrawn by anyone
   * but certification (only a person can, through the API; certification marks its own as
   * satisfied first) owes nothing more, and what it was declared for as lost is accepted. An open
   * one declared before records were kept gets one now, from the result that declared it.
   */
  private reconcile(): void {
    const records = new Map(this.records().map((r) => [r.intentId, r]));
    for (const intent of this.host.repairs()) {
      const rec = records.get(intent.id);
      if (!rec) {
        if (isOpen(intent.status)) this.saveRecord(this.legacyRecord(intent));
      } else if (rec.state === "pending" && intent.status === "withdrawn") {
        this.release(rec);
      }
    }
  }

  /** A record for a repair intent declared before records were kept: the declaring result's failing tests (none known: any green run satisfies it, as before). */
  private legacyRecord(intent: RepairRow): RepairRecord {
    const row = this.host.sql.exec<{ data: string }>("SELECT data FROM certifications WHERE instr(data, ?) > 0 LIMIT 1", `"repairIntentId":${JSON.stringify(intent.id)}`).toArray()[0];
    let cert: Certification | null = null;
    try {
      cert = row ? (JSON.parse(row.data) as Certification) : null;
    } catch {
      cert = null;
    }
    return { intentId: intent.id, sha: cert?.trunkSha ?? "", state: "pending", at: intent.createdAt, owed: Array.isArray(cert?.failing) ? owedOf(cert.failing) : [], lost: [] };
  }

  /** A person withdrew this repair intent: it owes nothing more, and what it named as lost leaves the baseline and every repair's obligations. */
  private release(rec: RepairRecord): void {
    this.saveRecord({ ...rec, state: "released" });
    if (rec.lost.length === 0) return;
    const b = this.baseline();
    if (b && acceptInBaseline(b, rec.lost)) this.setBaseline(b);
    for (const other of this.records(true)) {
      const owed = acceptInOwed(other.owed, rec.lost);
      if (owed.length !== other.owed.length) this.saveRecord({ ...other, owed });
    }
  }

  /** The baseline (owed.ts), or null before the first green run that recorded one. */
  private baseline(): Baseline | null {
    const sha = this.meta("baseline");
    if (!sha) return null;
    const files = new Map<Path, Kept>();
    for (const r of this.host.sql.exec<{ path: string; data: string }>("SELECT path, data FROM certify_baseline ORDER BY path").toArray()) {
      const kept = parseKept(r.data);
      if (kept !== null) files.set(r.path, kept);
    }
    return { sha, files };
  }

  /** Make `b` the baseline, rewriting only the files whose passing tests changed. */
  private setBaseline(b: Baseline): void {
    const old = new Map(
      this.host.sql
        .exec<{ path: string; data: string }>("SELECT path, data FROM certify_baseline")
        .toArray()
        .map((r) => [r.path, r.data]),
    );
    for (const [path, kept] of b.files) {
      const data = JSON.stringify(kept);
      if (old.get(path) !== data) this.host.sql.exec("INSERT OR REPLACE INTO certify_baseline (path, data) VALUES (?, ?)", path, data);
      old.delete(path);
    }
    for (const path of old.keys()) this.host.sql.exec("DELETE FROM certify_baseline WHERE path = ?", path);
    this.setMeta("baseline", b.sha);
  }

  /** Repair records, oldest first (only the ones still owed, when `owed`). */
  private records(owed = false): RepairRecord[] {
    const rows = this.host.sql
      .exec<{ intent_id: string; trunk_sha: string; state: string; at: number; owed: string; lost: string }>(
        `SELECT intent_id, trunk_sha, state, at, owed, lost FROM certify_repairs${owed ? " WHERE state NOT IN ('satisfied', 'released')" : ""} ORDER BY at, intent_id`,
      )
      .toArray();
    return rows.map((r) => ({
      intentId: r.intent_id,
      sha: r.trunk_sha,
      // An unknown state (a later version's) is treated as still owed.
      state: r.state === "satisfied" || r.state === "released" ? r.state : "pending",
      at: r.at,
      owed: listOf(r.owed, isOwed),
      lost: listOf(r.lost, isLostKey),
    }));
  }

  private saveRecord(r: RepairRecord): void {
    this.host.sql.exec(
      `INSERT INTO certify_repairs (intent_id, trunk_sha, state, at, owed, lost) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(intent_id) DO UPDATE SET trunk_sha = excluded.trunk_sha, state = excluded.state, at = excluded.at, owed = excluded.owed, lost = excluded.lost`,
      r.intentId,
      r.sha,
      r.state,
      r.at,
      JSON.stringify(r.owed),
      JSON.stringify(r.lost),
    );
    this.host.sql.exec(
      "DELETE FROM certify_repairs WHERE intent_id IN (SELECT intent_id FROM certify_repairs WHERE state IN ('satisfied', 'released') ORDER BY at DESC, intent_id DESC LIMIT -1 OFFSET ?)",
      KEEP_REPAIRS,
    );
  }

  private meta(k: string): string | null {
    return this.host.sql.exec<{ v: string }>("SELECT v FROM certify_meta WHERE k = ?", k).toArray()[0]?.v ?? null;
  }

  private setMeta(k: string, v: string): void {
    this.host.sql.exec("INSERT INTO certify_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v", k, v);
  }

  private deleteMeta(k: string): void {
    this.host.sql.exec("DELETE FROM certify_meta WHERE k = ?", k);
  }
}

/** Statuses a certification can have (for request validation). */
export const CERTIFICATION_STATUSES: readonly CertificationStatus[] = ["running", "green", "red", "error", "skipped"];

/**
 * Where a test's fix has to be written besides the code its file loads (see repairIntent): lost
 * tests are put back in their own file, a file that did not run is fixed where it was kept out
 * (itself, a module with a package import, or a deleted file restored), and a test file that does
 * not parse is fixed in itself. Otherwise nowhere: test files are context only.
 */
function fixIn(t: { file: Path; name?: string }, lost: Lost | undefined, loaded: Loaded | null): Path[] {
  if (lost) {
    if (lost.scope === "test" || lost.via === null || lost.via === lost.file) return [lost.file];
    return lost.via ? [lost.via] : [];
  }
  return loaded?.modules.get(t.file)?.error !== undefined ? [t.file] : [];
}

/** What a repair intent keeps of a loss. */
function lostKey(l: Lost): LostKey {
  const k: LostKey = { file: l.file, scope: l.scope };
  if (l.name !== undefined) k.name = l.name;
  if (l.count !== undefined) k.count = l.count;
  return k;
}

/** A baseline row: test names, or their number; null when unreadable (the file then owes nothing). */
function parseKept(data: string): Kept | null {
  try {
    const v = JSON.parse(data) as unknown;
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    if (Array.isArray(v) && v.every((n) => typeof n === "string")) return v as string[];
  } catch {
    // Unreadable: owe nothing for this file.
  }
  return null;
}

/** A stored JSON list, keeping only the entries `ok` accepts (unreadable data owes nothing). */
function listOf<T>(data: string, ok: (v: unknown) => v is T): T[] {
  try {
    const v = JSON.parse(data) as unknown;
    return Array.isArray(v) ? v.filter(ok) : [];
  } catch {
    return [];
  }
}

function isOwed(v: unknown): v is Owed {
  const o = v as Owed;
  return !!o && typeof o.file === "string" && (o.kind === "test" || o.kind === "suite" || o.kind === "file") && (o.name === undefined || typeof o.name === "string");
}

function isLostKey(v: unknown): v is LostKey {
  const k = v as LostKey;
  return !!k && typeof k.file === "string" && (k.scope === "test" || k.scope === "file") && (k.name === undefined || typeof k.name === "string") && (k.count === undefined || typeof k.count === "number");
}
