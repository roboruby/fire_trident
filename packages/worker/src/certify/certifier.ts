import type { Certification, CertificationStatus, ColonyEvent, FailingTest, Id, Landing, NoteCertification, Path, Sha } from "@fire_trident/core";
import { TEST_FILE } from "./compile.ts";
import { DEFAULT_CAPS, load, testFiles, type CompileMemo, type IndexedFile, type Loaded } from "./load.ts";
import { RUNNER_VERSION, buildPlan, closureOf, type Plan } from "./plan.ts";
import { DEFAULT_POLICY, mergePolicy, repairAction, repairIntent, type CertifyPolicy, type RepairIntentInput, type RepairRow } from "./repair.ts";
import { summarize, type RunReport } from "./report.ts";
import { fileKeyText, mergeResults, splitReport, type FileResult } from "./cache.ts";
import { CertifySchedule } from "./schedule.ts";

/**
 * Trunk certification: after a landing moves trunk, run the project's own tests on it in a
 * Dynamic Worker and record the result per commit. ColonyDO hosts it (CertifyHost); the work is
 * asynchronous and never on a landing's path: onLanding only marks trunk as moved.
 *
 * One run: read the trunk index from TrunkDO (one call), read the test files and the modules they
 * reach (by blob id, so the snapshot is one commit), transpile TypeScript, load every test file
 * into one Dynamic Worker with no network (globalOutbound: null) and a CPU and wall-clock limit,
 * and count the results the way `node --test` does. Green moves the colony's greenSha; red keeps
 * the last green and may declare a repair intent. Results are recorded, published as `certify`
 * events (so replays show them), and added to the certified landing's lineage note.
 */

/** The TrunkDO calls certification makes. */
export interface CertifyTrunk {
  certifySnapshot(p?: { maxFiles?: number }): Promise<{ trunkSha: Sha; landingId: Id | null; files: IndexedFile[]; truncated: boolean }>;
  readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>>;
  annotate(landingId: Id, patch: Record<string, unknown>): Promise<boolean>;
  /** Move the trunk repository's `certified` branch to a commit whose tests passed. */
  markCertified(sha: Sha): Promise<boolean>;
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
/** Failing tests a lineage note carries. */
const NOTE_FAILING = 20;
/** CPU the test Worker may use per run at most (it also stops at the wall-clock limit). */
const MAX_CPU_MS = 30_000;
/** The largest report the test Worker may answer with. */
const MAX_REPORT_CHARS = 4 * 1024 * 1024;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS certifications (
    trunk_sha TEXT PRIMARY KEY, landing_id TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER,
    inputs TEXT, test_key TEXT, data TEXT NOT NULL)`,
  "CREATE INDEX IF NOT EXISTS certifications_by_start ON certifications(started_at)",
  "CREATE TABLE IF NOT EXISTS certify_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)",
  // Per test file results, keyed by what the file reaches (cache.ts).
  "CREATE TABLE IF NOT EXISTS certify_files (key TEXT PRIMARY KEY, path TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)",
  "CREATE INDEX IF NOT EXISTS certify_files_by_at ON certify_files(at)",
];
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
  private inflight: Promise<void> | null = null;
  private forced = false;
  private policyCache: CertifyPolicy | null = null;
  private readonly memo: CompileMemo = new Map();
  /** The latest result said there is nothing to run (no test files, or none for node:test); null otherwise or unknown. */
  private nothingToRun: boolean | null = null;

  constructor(private readonly host: CertifyHost) {
    this.ensureSchema();
    this.schedule = new CertifySchedule(DEFAULT_POLICY.minIntervalMs);
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
    this.inflight = this.runOnce(forced, (s) => {
      sha = s;
      this.schedule.certifying(s);
    })
      .catch((err: unknown) => console.warn(`certification failed: ${errorText(err)}`))
      .finally(() => {
        this.schedule.finish(sha);
        this.inflight = null;
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

    const tests = testFiles(snap.files);
    if (tests.length === 0) return this.skip(base, "no test files (*.test.ts or *.test.js)", null, last);
    const testKey = await digest(tests.map((t) => `${t.path} ${t.blob}`).join("\n"));
    if (last && last.foreign && last.testKey === testKey) return this.skip(base, last.cert.detail ?? "no test file imports node:test", testKey, last, true);

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
    if (loaded.tests.length === 0) {
      const foreign = loaded.unsupported.every((u) => u.reason === "does not import node:test");
      const detail = foreign ? `no test file imports node:test (${tests.length} test file${tests.length === 1 ? "" : "s"})` : `no test file can run here: ${loaded.unsupported.slice(0, 3).map((u) => `${u.path} ${u.reason}`).join("; ")}`;
      return this.skip({ ...base, unsupported: loaded.unsupported.slice(0, 20) }, detail, testKey, last, foreign);
    }
    // Each test file's key: what it reaches (paths and blob ids), the runner, the per-test limit.
    const keys = new Map<Path, string>();
    for (const t of loaded.tests) keys.set(t, await digest(fileKeyText(t, closureOf(t, loaded.modules), loaded.blobs, RUNNER_VERSION, policy.testTimeoutMs)));
    const inputs = await digest([...keys].map(([p, k]) => `${p} ${k}`).join("\n"));
    const common: Certification = { ...base, files: loaded.tests.length };
    if (loaded.unsupported.length > 0) common.unsupported = loaded.unsupported.slice(0, 20);

    // The files the tests reach are the same as an earlier run's: its verdict holds (tests are deterministic by contract).
    const same = !forced ? this.byInputs(inputs) : null;
    if (same && (same.cert.status === "green" || same.cert.status === "red")) {
      const reused: Certification = { ...common, status: same.cert.status, reusedFrom: same.cert.reusedFrom ?? same.cert.trunkSha, cached: loaded.tests.length, timing: { indexMs, loadMs, workerMs: 0 } };
      if (same.cert.counts) reused.counts = same.cert.counts;
      if (same.cert.failing) reused.failing = same.cert.failing;
      if (same.cert.runMs !== undefined) reused.runMs = same.cert.runMs;
      return this.finish(reused, inputs, testKey, loaded);
    }

    // Test files whose inputs did not change keep their results; only the others run.
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
        return this.finish({ ...common, status: "error", detail: clip(detail, 400)!, timing: { indexMs, loadMs, workerMs: Date.now() - t2 } }, inputs, testKey, loaded);
      }
      workerMs = Date.now() - t2;
      runMs = report.ms;
      modules = { count: Object.keys(plan.modules).length, chars: plan.bytes };
      for (const [path, r] of splitReport(report, toRun, true)) results.set(path, r);
      this.storeFiles(splitReport(report, toRun), keys);
    }
    const s = summarize(mergeResults(loaded.tests, results, RUNNER_VERSION, runMs));
    const cert: Certification = { ...common, status: s.status, counts: s.counts, failing: s.failing, runMs, timing: { indexMs, loadMs, workerMs } };
    if (cached.size > 0) cert.cached = cached.size;
    if (modules) cert.modules = modules;
    if (s.detail) cert.detail = s.detail;
    return this.finish(cert, inputs, testKey, loaded);
  }

  /** Load the plan into a Dynamic Worker and run it. */
  private async run(plan: Plan, policy: CertifyPolicy): Promise<RunReport> {
    const loader = this.host.loader();
    if (!loader) throw new Error("no Worker Loader binding");
    const worker = loader.load({
      compatibilityDate: RUNNER_COMPAT_DATE,
      compatibilityFlags: ["nodejs_compat"],
      mainModule: plan.mainModule,
      modules: plan.modules as Record<string, WorkerLoaderModule>,
      globalOutbound: null,
      limits: { cpuMs: Math.min(MAX_CPU_MS, policy.timeoutMs) },
    });
    const res = await withTimeout(worker.getEntrypoint().fetch("https://certify.invalid/run"), policy.timeoutMs, `the test run exceeded its ${Math.round(policy.timeoutMs / 1000)} s limit`);
    if (!res.ok) throw new Error(`the test Worker answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    // The answer is written by code from the repository: refuse one too large to parse safely here.
    const body = await res.text();
    if (body.length > MAX_REPORT_CHARS) throw new Error(`the test Worker's report is ${Math.round(body.length / 1024)} KB, over the ${MAX_REPORT_CHARS / 1024 / 1024} MB limit`);
    const report = JSON.parse(body) as RunReport;
    if (!report || !Array.isArray(report.tests)) throw new Error("the test Worker answered without a report");
    return report;
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

  /** Record a verdict (or a failed run): greenSha, the event, the repair loop, the lineage note. */
  private async finish(cert: Certification, inputs: string | null, testKey: string | null, loaded: Loaded | null): Promise<void> {
    cert.finishedAt = Date.now();
    cert.durationMs = cert.finishedAt - cert.startedAt;
    if (cert.status === "green") {
      this.host.setGreen(cert.trunkSha);
      // The `certified` branch follows green, so plain git can check out the last trunk whose tests passed.
      void this.host
        .trunk()
        .markCertified(cert.trunkSha)
        .catch((err: unknown) => console.warn(`certification: certified branch not moved: ${errorText(err)}`));
    }
    const green = this.host.greenSha();
    if (green) cert.greenSha = green;
    if (cert.status === "red" || cert.status === "green") {
      try {
        const repairId = await this.repair(cert, loaded);
        if (repairId) cert.repairIntentId = repairId;
      } catch (err) {
        console.warn(`certification: repair loop failed: ${errorText(err)}`);
      }
    }
    this.store({ cert, inputs: cert.status === "error" ? null : inputs, testKey });
    this.host.publish(this.event(cert));
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
  private async repair(cert: Certification, loaded: Loaded | null): Promise<Id | null> {
    const policy = this.policy();
    const action = repairAction(cert, this.host.repairs(), policy, Date.now());
    if (action.kind === "satisfy") {
      const c = cert.counts;
      const reason = `satisfied: trunk ${cert.trunkSha.slice(0, 7)} passes ${c ? `${c.pass} of ${c.tests} tests` : "its tests"}`;
      for (const id of action.ids) await this.host.satisfy(id, reason);
      return null;
    }
    if (action.kind !== "declare") return null;
    const files = [...new Set((cert.failing ?? []).map((f) => f.file))];
    const spec = this.host.specFor(files);
    const input = repairIntent({
      cert,
      reach: (file) => (loaded ? closureOf(file, loaded.modules) : [file]),
      isTest: (p) => TEST_FILE.test(p),
      spec: spec?.spec ?? null,
      ...(spec?.label ? { sourceLabel: spec.label } : {}),
    });
    return this.host.declare(input);
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
    return e;
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
