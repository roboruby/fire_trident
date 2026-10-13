import { describe, expect, it, vi } from "vitest";
import type { Certification, ColonyEvent, Path, Sha } from "@fire_trident/core";
import { Certifier, RUNNER_COMPAT_DATE, type CertifyHost, type CertifyTrunk } from "../../src/certify/certifier.ts";
import type { LandedOn } from "../../src/certify/culprit.ts";
import { MAIN_MODULE, RUNNER_FAILED, RUNNER_VERSION, SHIM_MODULE, type Plan } from "../../src/certify/plan.ts";
import type { RepairIntentInput } from "../../src/certify/repair.ts";
import type { RunReport } from "../../src/certify/report.ts";
import { runPlanInNode } from "./harness.ts";

/**
 * The certifier end to end in Node: a trunk of file texts, the colony's storage on an in-memory
 * SQLite database, and a Worker Loader stand-in that records what certification loads and answers
 * each run either by running the loaded harness in a real Node process or with a body built to
 * misbehave.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

/** A Durable Object SqlStorage over an in-memory database. */
function sqlStorage(): { sql: SqlStorage; db: DatabaseSync } {
  const db = new DatabaseSync(":memory:");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
  return { sql, db };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
/** The real timer, kept for when a test runs on a fake clock. */
const realSetTimeout = setTimeout;

/** A blob id that follows the content (FNV-1a and the length), so an unchanged file keeps its id across commits. */
function blobOf(text: string): Sha {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return `${h.toString(16).padStart(8, "0")}${text.length.toString(16)}`;
}

/** A trunk of file texts: each commit replaces files (null deletes) and gets the next sha; certified moves are recorded. */
class Trunk implements CertifyTrunk {
  sha: Sha = "";
  readonly files = new Map<Path, string>();
  readonly certified: Sha[] = [];
  /** baseBlobs() calls (culprit finding reads the green commit). */
  blobReads = 0;
  private readonly blobs = new Map<Sha, string>();
  /** Every commit's blob of each path, for baseBlobs(). */
  private readonly history = new Map<Sha, Map<Path, Sha>>();
  private n = 0;

  commit(changes: Record<Path, string | null>): Sha {
    for (const [path, text] of Object.entries(changes)) {
      if (text === null) this.files.delete(path);
      else this.files.set(path, text);
    }
    this.sha = (++this.n).toString(16).padStart(40, "0");
    this.history.set(this.sha, new Map([...this.files].map(([path, text]) => [path, blobOf(text)])));
    return this.sha;
  }

  async baseBlobs(sha: Sha, paths: Path[]): Promise<Array<{ path: Path; blob: Sha | null }>> {
    this.blobReads++;
    const at = this.history.get(sha);
    return paths.map((path) => ({ path, blob: at?.get(path) ?? null }));
  }

  async certifySnapshot(): Promise<{ trunkSha: Sha; landingId: null; files: Array<{ path: Path; blob: Sha; size: number }>; truncated: boolean }> {
    const files = [...this.files]
      .filter(([path]) => /\.(ts|js|mjs|json)$/.test(path))
      .map(([path, text]) => {
        const blob = blobOf(text);
        this.blobs.set(blob, text);
        return { path, blob, size: text.length };
      });
    return { trunkSha: this.sha, landingId: null, files, truncated: false };
  }

  async readBlobs(blobs: Sha[]): Promise<Record<Sha, string | null>> {
    return Object.fromEntries(blobs.map((b) => [b, this.blobs.get(b) ?? null]));
  }

  async annotate(): Promise<boolean> {
    return true;
  }

  async markCertified(sha: Sha): Promise<boolean> {
    this.certified.push(sha);
    return true;
  }
}

/** How the stand-in Worker answers a run, given what certification loaded. */
type Answer = (code: WorkerLoaderWorkerCode) => Promise<Response>;

/** A Worker Loader stand-in: records every load and answers each run's request with `answer`. */
function loaderOf(answer: Answer): WorkerLoader & { loads: WorkerLoaderWorkerCode[] } {
  const loads: WorkerLoaderWorkerCode[] = [];
  const load = (code: WorkerLoaderWorkerCode): WorkerStub => {
    loads.push(code);
    const entrypoint = { fetch: () => answer(code) };
    return { getEntrypoint: () => entrypoint } as unknown as WorkerStub;
  };
  return { loads, load } as unknown as WorkerLoader & { loads: WorkerLoaderWorkerCode[] };
}

/** Run what certification loaded with the real harness and node:test shim, in a Node process. */
const inNode: Answer = async (code) => new Response(JSON.stringify(runPlanInNode({ mainModule: code.mainModule, modules: code.modules } as unknown as Plan)));

/** The test files a loaded harness runs, in order (from its FILES table). */
function harnessFiles(code: WorkerLoaderWorkerCode): Path[] {
  const main = code.modules[MAIN_MODULE] as { js: string };
  return [...main.js.matchAll(/\{ path: ("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]!) as Path);
}

/** One passing test per test file, without running anything (where what runs is beside the point). */
const allPass: Answer = async (code) => {
  const files = harnessFiles(code);
  const report: RunReport = {
    runner: RUNNER_VERSION,
    ms: 1,
    files: files.map((path) => ({ path, ms: 1, tests: 1, loadError: null })),
    tests: files.map((path) => ({ name: "passes", file: path, status: "pass" as const })),
    suites: [],
  };
  return new Response(JSON.stringify(report));
};

/**
 * A certifier over `trunk` with a fresh database: runs start at once and red declares no repair (unless `policy` says otherwise).
 * `host` replaces parts of the colony (culprit finding is off unless it says otherwise).
 */
function setup(trunk: Trunk, loader: WorkerLoader, policy: Record<string, unknown> = {}, host: Partial<CertifyHost> = {}): { certifier: Certifier; db: DatabaseSync; declared: RepairIntentInput[] } {
  const { sql, db } = sqlStorage();
  let green: Sha | null = null;
  const declared: RepairIntentInput[] = [];
  const colony: CertifyHost = {
    sql,
    enabled: () => true,
    loader: () => loader,
    trunk: () => trunk,
    publish: () => undefined,
    exists: () => true,
    greenSha: () => green,
    setGreen: (sha) => {
      green = sha;
    },
    repairs: () => declared.map((_, i) => ({ id: `int_${i + 1}`, status: "open" as const, createdAt: 0 })),
    declare: async (input) => {
      declared.push(input);
      return `int_${declared.length}`;
    },
    satisfy: async () => undefined,
    specFor: () => null,
  };
  const certifier = new Certifier({ ...colony, ...host });
  const set = certifier.setPolicy({ minIntervalMs: 0, repair: false, ...policy });
  if ("error" in set) throw new Error(set.error);
  return { certifier, db, declared };
}

/** Wait until no run is in flight or asked for and `sha` has a result. */
async function settled(c: Certifier, sha: Sha, timeoutMs = 30_000): Promise<Certification> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const state = c.state();
    const found = c.get(sha);
    if (found && found.status !== "running" && !state.running && !state.pending) return found;
    if (Date.now() > until) throw new Error(`no certification of ${sha} yet: ${JSON.stringify(found)}`);
    await sleep(25);
  }
}

/** Report the trunk's head as landed (with the paths that changed) and wait for its certification. */
async function land(c: Certifier, trunk: Trunk, paths: Path[]): Promise<Certification> {
  c.landed({ trunkSha: trunk.sha, at: Date.now(), paths });
  return settled(c, trunk.sha);
}

function rows<T>(db: DatabaseSync, sql: string): T[] {
  return db.prepare(sql).all() as T[];
}

const MATH = "export function add(a: number, b: number): number {\n  return a + b;\n}\n";
const MATH_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { add } from "../src/math.ts";\ntest("adds", () => {\n  assert.equal(add(2, 3), 5);\n});\n';
const passing = (name: string): string => `import { test } from "node:test";\ntest(${JSON.stringify(name)}, () => {});\n`;

describe("what certification loads into the test Worker", () => {
  it("no network, no env or bindings, a CPU limit, and only the modules the tests reach (with the shim and the harness)", async () => {
    const trunk = new Trunk();
    trunk.commit({ "src/math.ts": MATH, "src/unused.ts": "export const unused = 1;\n", "src/conf.json": "{}\n", "test/math.test.ts": MATH_TEST, "test/other.test.ts": passing("other"), "README.md": "# x\n" });
    const loader = loaderOf(allPass);
    const { certifier } = setup(trunk, loader);
    expect(await land(certifier, trunk, [...trunk.files.keys()])).toMatchObject({ status: "green", files: 2, counts: { tests: 2, pass: 2 } });
    expect(loader.loads).toHaveLength(1);
    const code = loader.loads[0]!;
    // Nothing besides these: no env (so no bindings and an empty process.env), no tails, no flag past nodejs_compat.
    expect(Object.keys(code).sort()).toEqual(["compatibilityDate", "compatibilityFlags", "globalOutbound", "limits", "mainModule", "modules"]);
    expect(code.globalOutbound).toBeNull();
    expect(code.env).toBeUndefined();
    expect(code.compatibilityDate).toBe(RUNNER_COMPAT_DATE);
    expect(code.compatibilityFlags).toEqual(["nodejs_compat"]);
    expect(code.limits).toEqual({ cpuMs: 30_000 });
    expect(code.mainModule).toBe(MAIN_MODULE);
    expect(Object.keys(code.modules).sort()).toEqual([MAIN_MODULE, `t0/${SHIM_MODULE}`, "t0/src/math.ts", "t0/test/math.test.ts", `t1/${SHIM_MODULE}`, "t1/test/other.test.ts"].sort());
    // A shorter run limit lowers the CPU limit with it.
    certifier.setPolicy({ timeoutMs: 20_000 });
    certifier.certifyNow();
    await settled(certifier, trunk.sha);
    expect(loader.loads[1]!.limits).toEqual({ cpuMs: 20_000 });
  }, 60_000);
});

describe("reusing per-file results", () => {
  it("reuses the results of a run in which each test file had its own module copy", async () => {
    const trunk = new Trunk();
    const sha1 = trunk.commit({ "test/a.test.ts": passing("a"), "test/b.test.ts": passing("b") });
    const loader = loaderOf(allPass);
    const { certifier, db } = setup(trunk, loader);
    expect(await land(certifier, trunk, ["test/a.test.ts", "test/b.test.ts"])).toMatchObject({ status: "green", files: 2 });
    expect(rows(db, "SELECT path FROM certify_files ORDER BY path")).toEqual([{ path: "test/a.test.ts" }, { path: "test/b.test.ts" }]);
    trunk.commit({ "src/other.ts": "export const other = 1;\n" });
    expect(await land(certifier, trunk, ["src/other.ts"])).toMatchObject({ status: "green", files: 2, cached: 2, reusedFrom: sha1 });
    expect(loader.loads).toHaveLength(1);
  }, 60_000);

  it("never keeps per-file results from a run whose test files shared one module copy", async () => {
    // Sixteen test files reaching a 400 KB module: a copy each would be over 6 MB, so they share one.
    const files: Record<Path, string> = { "src/big.js": `export const big = "${"x".repeat(400 * 1024)}";\nexport function add(a, b) {\n  return a + b;\n}\n` };
    for (let i = 0; i < 16; i++) {
      files[`test/t${String(i).padStart(2, "0")}.test.js`] = `import { test } from "node:test";\nimport assert from "node:assert";\nimport { add } from "../src/big.js";\ntest("adds ${i}", () => {\n  assert.strictEqual(add(${i}, 1), ${i + 1});\n});\n`;
    }
    const trunk = new Trunk();
    trunk.commit(files);
    const loader = loaderOf(allPass);
    const { certifier, db } = setup(trunk, loader);
    expect(await land(certifier, trunk, Object.keys(files))).toMatchObject({ status: "green", files: 16, counts: { tests: 16, pass: 16 } });
    const keys = Object.keys(loader.loads[0]!.modules).filter((k) => k !== MAIN_MODULE);
    expect(keys.every((k) => k.startsWith("t0/"))).toBe(true);
    expect(keys.filter((k) => k.endsWith("src/big.js"))).toEqual(["t0/src/big.js"]);
    expect(rows(db, "SELECT path FROM certify_files")).toEqual([]);
    // So the next run reuses nothing: every file runs again.
    trunk.commit({ "src/other.ts": "export const other = 1;\n" });
    const again = await land(certifier, trunk, ["src/other.ts"]);
    expect(again).toMatchObject({ status: "green", files: 16, counts: { tests: 16, pass: 16 } });
    expect(again.cached).toBeUndefined();
    expect(again.reusedFrom).toBeUndefined();
    expect(loader.loads).toHaveLength(2);
  }, 60_000);
});

describe("a test file that breaks the runner for the files after it", () => {
  it("makes the run red, keeps the baseline and certified, and never keeps the result of the file that did not run", async () => {
    const trunk = new Trunk();
    const sha1 = trunk.commit({ "test/a.test.ts": passing("a passes"), "test/b.test.ts": passing("b passes") });
    const loader = loaderOf(inNode);
    const { certifier, db } = setup(trunk, loader);
    expect(await land(certifier, trunk, ["test/a.test.ts", "test/b.test.ts"])).toMatchObject({ status: "green", counts: { tests: 2, pass: 2 } });
    const baseline = [
      { path: "test/a.test.ts", data: '["a passes"]' },
      { path: "test/b.test.ts", data: '["b passes"]' },
    ];
    expect(rows(db, "SELECT path, data FROM certify_baseline ORDER BY path")).toEqual(baseline);

    // Both files change, so both run in one Worker: a replaces Object.assign, which b's runner calls as it loads.
    const breaks = `${passing("a passes")}Object.assign = () => {\n  throw new Error("assign is gone");\n};\n`;
    trunk.commit({ "test/a.test.ts": breaks, "test/b.test.ts": `${passing("b passes")}// changed\n` });
    const red = await land(certifier, trunk, ["test/a.test.ts", "test/b.test.ts"]);
    expect(red).toMatchObject({ status: "red", greenSha: sha1, counts: { tests: 2, pass: 1, fail: 1 } });
    expect(red.failing).toEqual([{ name: "test/b.test.ts", file: "test/b.test.ts", error: `${RUNNER_FAILED}assign is gone` }]);
    expect(trunk.certified).toEqual([sha1]);
    expect(rows(db, "SELECT path, data FROM certify_baseline ORDER BY path")).toEqual(baseline);
    expect(rows(db, "SELECT v FROM certify_meta WHERE k = 'baseline'")).toEqual([{ v: sha1 }]);
    // a's result is kept (its own test passed); b's is not: it depended on the file before it.
    expect(rows(db, "SELECT path FROM certify_files ORDER BY path")).toEqual([{ path: "test/a.test.ts" }, { path: "test/a.test.ts" }, { path: "test/b.test.ts" }]);

    // The next run runs b again (alone, as node --test runs every file), and only then counts it.
    const sha3 = trunk.commit({ "src/other.ts": "export const other = 1;\n" });
    const next = await land(certifier, trunk, ["src/other.ts"]);
    expect(Object.keys(loader.loads[2]!.modules).filter((k) => k.startsWith("t"))).toEqual([`t0/test/b.test.ts`, `t0/${SHIM_MODULE}`]);
    expect(next).toMatchObject({ status: "green", greenSha: sha3, cached: 1, counts: { tests: 2, pass: 2 } });
    expect(rows(db, "SELECT path, data FROM certify_baseline ORDER BY path")).toEqual(baseline);
    expect(rows(db, "SELECT v FROM certify_meta WHERE k = 'baseline'")).toEqual([{ v: sha3 }]);
  }, 60_000);

  it("is an error, not red, when the runner cannot start before any test file loaded (nothing is judged or kept)", async () => {
    const trunk = new Trunk();
    trunk.commit({ "test/a.test.ts": passing("a"), "test/b.test.ts": passing("b") });
    const error = `${RUNNER_FAILED}node:async_hooks is not available`;
    const report: RunReport = {
      runner: RUNNER_VERSION,
      ms: 1,
      files: ["test/a.test.ts", "test/b.test.ts"].map((path) => ({ path, ms: 0, tests: 1, loadError: error })),
      tests: ["test/a.test.ts", "test/b.test.ts"].map((path) => ({ name: path, file: path, status: "fail" as const, error })),
      suites: [],
    };
    const { certifier, db, declared } = setup(trunk, loaderOf(async () => new Response(JSON.stringify(report))), { repair: true });
    expect(await land(certifier, trunk, ["test/a.test.ts", "test/b.test.ts"])).toMatchObject({
      status: "error",
      detail: "the test runner failed: it could not start: node:async_hooks is not available",
    });
    expect(declared).toEqual([]);
    expect(rows(db, "SELECT path FROM certify_files")).toEqual([]);
    expect(rows(db, "SELECT path FROM certify_baseline")).toEqual([]);
  }, 60_000);
});

describe("reading the test Worker's answer", () => {
  it("stops a body that never ends or trickles at the run's deadline, one past the cap at the cap, and drops an answer that comes too late", async () => {
    // A fake clock (timers and Date only): the runs' deadlines pass without the test waiting for them,
    // while the real work between them (digests, stream reads) runs as usual.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const cancelled: Record<string, boolean> = {};
      const stream = (name: string, pull: (c: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>): ReadableStream<Uint8Array> =>
        new ReadableStream<Uint8Array>({
          pull,
          cancel: () => {
            cancelled[name] = true;
          },
        });
      const forever = (): Promise<void> => new Promise<void>(() => undefined);
      const answers: Record<string, Answer> = {
        // The headers come at once and the body never ends.
        endless: async () => new Response(stream("endless", forever)),
        // One byte every 100 ms, without end.
        trickle: async () =>
          new Response(
            stream("trickle", async (c) => {
              await sleep(100);
              c.enqueue(new Uint8Array([0x20]));
            }),
          ),
        // 64 KB chunks without end: past the 4 MB cap long before the deadline.
        large: async () => new Response(stream("large", (c) => c.enqueue(new Uint8Array(64 * 1024).fill(0x20)))),
        // A failed answer whose body never ends: only its first bytes are read, for the message.
        failed: async () => new Response(stream("failed", (c) => c.enqueue(new TextEncoder().encode("boom "))), { status: 500 }),
        // The answer itself comes after the deadline: dropped unread.
        late: async () => {
          await sleep(6_000);
          return new Response(stream("late", forever));
        },
      };
      const runs = Object.entries(answers).map(([name, answer]) => {
        const trunk = new Trunk();
        trunk.commit({ "test/a.test.ts": passing("a") });
        // The least time a colony's policy allows for one run.
        const { certifier } = setup(trunk, loaderOf(answer), { timeoutMs: 5_000 });
        certifier.landed({ trunkSha: trunk.sha, at: Date.now(), paths: ["test/a.test.ts"] });
        return { name, certifier, sha: trunk.sha };
      });
      const finished = (): boolean =>
        runs.every((r) => {
          const state = r.certifier.state();
          const cert = r.certifier.get(r.sha);
          return !!cert && cert.status !== "running" && !state.running && !state.pending;
        });
      // Up to 10 s of the fake clock, in steps, with real time between them for the work to run.
      for (let step = 0; step < 100 && !(finished() && cancelled.late); step++) {
        await vi.advanceTimersByTimeAsync(100);
        await new Promise<void>((r) => realSetTimeout(r, 1));
      }
      const by = Object.fromEntries(runs.map((r) => [r.name, r.certifier.get(r.sha)!]));
      const late = "the test run used up its CPU or time limit: the test run exceeded its 5 s limit";
      for (const name of ["endless", "trickle", "late"]) {
        expect(by[name]).toMatchObject({ status: "error", detail: late });
        // Stopped at the deadline (to one step of the clock), not after it.
        expect(by[name]!.durationMs).toBeGreaterThanOrEqual(5_000);
        expect(by[name]!.durationMs).toBeLessThanOrEqual(5_200);
      }
      expect(by.large).toMatchObject({ status: "error", detail: "the test runner failed: the test Worker's report is over the 4 MB limit" });
      expect(by.failed).toMatchObject({ status: "error", detail: `the test runner failed: the test Worker answered 500: ${"boom ".repeat(60)}` });
      for (const name of ["large", "failed"]) expect(by[name]!.durationMs).toBeLessThan(1_000);
      // Every body was cancelled, the late one when it came.
      expect(cancelled).toEqual({ endless: true, trickle: true, large: true, failed: true, late: true });
    } finally {
      vi.useRealTimers();
    }
  }, 30_000);

  it("is an error, never a run stuck in progress, when the answer is not a report", async () => {
    for (const body of ['{"tests":[],"suites":[],"files":"test/a.test.ts"}', '{"tests":[null],"suites":[],"files":[]}', "[]"]) {
      const trunk = new Trunk();
      trunk.commit({ "test/a.test.ts": passing("a") });
      const { certifier } = setup(trunk, loaderOf(async () => new Response(body)));
      expect(await land(certifier, trunk, ["test/a.test.ts"])).toMatchObject({ status: "error", detail: "the test runner failed: the test Worker answered without a report" });
    }
  }, 60_000);
});

describe("culprit finding in a red run", () => {
  const SUB = (op: string): string => `export function sub(a: number, b: number): number {\n  return a ${op} b;\n}\n`;
  const SUB_TEST = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sub } from "../src/math.ts";\ntest("subtracts", () => {\n  assert.equal(sub(5, 3), 2);\n});\n';

  it("names the landings since green that changed what a failing test loads: on the result, its event and its repair intent", async () => {
    const trunk = new Trunk();
    const sha1 = trunk.commit({ "src/math.ts": SUB("-"), "test/math.test.ts": SUB_TEST, "README.md": "# x\n" });
    const asked: Path[][] = [];
    const events: ColonyEvent[] = [];
    let found: LandedOn[] = [];
    const { certifier, declared } = setup(
      trunk,
      loaderOf(inNode),
      { repair: true },
      {
        culprits: () => true,
        landedOn: async (paths) => {
          asked.push(paths);
          return found;
        },
        landingOf: (sha) => (sha === sha1 ? { landingId: "lnd_1", at: 100 } : null),
        publish: (e) => {
          events.push(...(Array.isArray(e) ? e : [e]));
        },
      },
    );
    expect(await land(certifier, trunk, ["src/math.ts", "test/math.test.ts"])).toMatchObject({ status: "green" });
    const sha2 = trunk.commit({ "src/math.ts": SUB("+") });
    found = [
      { landingId: "lnd_2", at: 200, trunkSha: sha2, proposalId: "prp_2", intentId: "int_2", title: "Speed up sub", why: "It was slow.", paths: ["src/math.ts"], wrote: { "src/math.ts": "x" } },
      // The green commit's own landing: not a suspect.
      { landingId: "lnd_1", at: 100, trunkSha: sha1, proposalId: "prp_1", intentId: "int_1", title: "Add sub", why: "We need it.", paths: ["src/math.ts"] },
    ];
    const red = await land(certifier, trunk, ["src/math.ts"]);
    expect(red).toMatchObject({ status: "red", greenSha: sha1, repairIntentId: "int_1" });
    // One read of the green commit, one index lookup with what changed under the failing file.
    expect(trunk.blobReads).toBe(1);
    expect(asked).toEqual([["src/math.ts"]]);
    const suspect = { landingId: "lnd_2", at: 200, trunkSha: sha2, proposalId: "prp_2", intentId: "int_2", title: "Speed up sub", paths: ["src/math.ts"], files: ["test/math.test.ts"] };
    expect(red.suspects).toEqual([suspect]);
    expect(certifier.state().latest?.suspects).toEqual([suspect]);
    const published = events.filter((e): e is Extract<ColonyEvent, { t: "certify" }> => e.t === "certify" && e.status === "red");
    expect(published.at(-1)?.suspects).toEqual([suspect]);
    // The repair intent names it as data and can write the file it changed.
    expect(declared).toHaveLength(1);
    expect(declared[0]!.footprint).toEqual(["src/math.ts"]);
    expect(declared[0]!.why).toMatch(
      /\n<<<SUSPECTS ([0-9a-f]{12})>>>\n- proposal prp_2 \(landing lnd_2, commit 0000000\) for intent int_2 "Speed up sub" changed src\/math\.ts; a suspect for test\/math\.test\.ts\. Why it was written: It was slow\.\n<<<END SUSPECTS \1>>>\n/,
    );
  }, 60_000);

  it("fails open: a lookup that throws or takes too long leaves the result without suspects, and the repair comes as before", async () => {
    const failing: Array<NonNullable<CertifyHost["landedOn"]>> = [
      async () => {
        throw new Error("the landing index is unavailable");
      },
      () => new Promise<LandedOn[]>(() => undefined),
    ];
    for (const landedOn of failing) {
      const trunk = new Trunk();
      trunk.commit({ "src/math.ts": SUB("-"), "test/math.test.ts": SUB_TEST });
      const { certifier, declared } = setup(trunk, loaderOf(inNode), { repair: true }, { culprits: () => true, landedOn });
      expect(await land(certifier, trunk, ["src/math.ts", "test/math.test.ts"])).toMatchObject({ status: "green" });
      trunk.commit({ "src/math.ts": SUB("+") });
      const red = await land(certifier, trunk, ["src/math.ts"]);
      expect(red).toMatchObject({ status: "red", repairIntentId: "int_1", counts: { fail: 1 } });
      expect(red.suspects).toBeUndefined();
      expect(declared).toHaveLength(1);
      expect(declared[0]!.why).not.toContain("SUSPECTS");
    }
  }, 60_000);

  it("is off unless the colony turns it on: no trunk read, no index lookup", async () => {
    const trunk = new Trunk();
    trunk.commit({ "src/math.ts": SUB("-"), "test/math.test.ts": SUB_TEST });
    let lookups = 0;
    const landedOn = async (): Promise<LandedOn[]> => {
      lookups++;
      return [];
    };
    const { certifier } = setup(trunk, loaderOf(inNode), {}, { culprits: () => false, landedOn });
    await land(certifier, trunk, ["src/math.ts", "test/math.test.ts"]);
    trunk.commit({ "src/math.ts": SUB("+") });
    const red = await land(certifier, trunk, ["src/math.ts"]);
    expect(red.status).toBe("red");
    expect(red.suspects).toBeUndefined();
    expect(trunk.blobReads).toBe(0);
    expect(lookups).toBe(0);
  }, 60_000);
});
