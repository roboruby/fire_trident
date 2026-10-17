import { describe, expect, it } from "vitest";
import { intentSpend, type Certification, type Landing, type LineageNote, type Path, type Sha } from "@fire_trident/core";
import { LandingTestsReader, TESTS_VERSION, authorsOf, certificationOff, fileKeys, landingSpend, originOf, placeLanding, reachingFiles, writtenCode, type LandingTestsHost, type LandingTestsTrunk } from "../../src/certify/landingtests.ts";
import { DEFAULT_CAPS, load, type IndexedFile } from "../../src/certify/load.ts";
import type { TestFileLineage } from "../../src/certify/testlineage.ts";

/**
 * A landing's test row in Node: certification's tables on an in-memory SQLite database, a trunk writer that keeps a few
 * commits' trees, and the real tree reads (load.ts) and keys (cache.ts) certification uses, so the row finds the results
 * certification stored under each test file's key.
 */

/** The part of node:sqlite these tests use (the worker compiles against workers types, not Node's). */
interface DatabaseSync {
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
  exec(sql: string): void;
}
const SQLITE = "node:sqlite";
const { DatabaseSync } = (await import(SQLITE)) as { DatabaseSync: new (path: string) => DatabaseSync };

const GEMMA = "@cf/google/gemma-4-26b-a4b-it";
/** 40 hex digits from a text (five FNV-1a rounds with different seeds): a stand-in commit or blob id. */
function hex40(text: string): Sha {
  let out = "";
  for (let seed = 0; seed < 5; seed++) {
    let h = (0x811c9dc5 ^ seed) >>> 0;
    for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out;
}
const sha = (label: string): Sha => hex40(`commit ${label}`);
const blobOf = (text: string): Sha => hex40(`blob ${text}`);
const TIMEOUT = 10_000;

const MATH = "export const add = (a, b) => a + b;\n";
const MATH2 = "export const add = (a, b) => b + a;\n";
const MATH_TEST = 'import { test } from "node:test";\nimport { add } from "../src/math.js";\ntest("adds", () => add(1, 2));\n';
const OTHER_TEST = 'import { test } from "node:test";\ntest("other", () => {});\n';
const NEW = "export const fresh = 1;\n";
const NEW_TEST = 'import { test } from "node:test";\nimport { fresh } from "../src/new.js";\ntest("fresh", () => fresh);\n';

type Tree = Record<Path, string>;
type Outcomes = Record<Path, Array<[string, string]>>;

/** One colony and its trunk: commits in chain order, landings, certification's stored results, and a row reader over them. */
function world(opts: { lineage?: Record<Path, TestFileLineage>; off?: string | null; spend?: LandingTestsHost["spend"] } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE certifications (trunk_sha TEXT PRIMARY KEY, landing_id TEXT, status TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, inputs TEXT, test_key TEXT, data TEXT NOT NULL)",
  );
  db.exec("CREATE TABLE certify_files (key TEXT PRIMARY KEY, path TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL)");
  const sql = {
    exec(query: string, ...bindings: unknown[]) {
      const rows = db.prepare(query).all(...bindings);
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    },
  } as unknown as SqlStorage;
  const chain: Sha[] = [];
  const trees = new Map<Sha, Tree>();
  const blobs = new Map<Sha, string>();
  const landings = new Map<string, { landing: Landing; note: LineageNote | null }>();
  const calls: string[] = [];
  let clock = 1_000;

  const commit = (label: string, tree: Tree): Sha => {
    const s = sha(label);
    chain.push(s);
    trees.set(s, tree);
    for (const text of Object.values(tree)) blobs.set(blobOf(text), text);
    return s;
  };
  const index = (s: Sha): IndexedFile[] =>
    Object.entries(trees.get(s) ?? {})
      .filter(([p]) => /\.(ts|js|mjs|json)$/.test(p))
      .map(([path, text]) => ({ path, blob: blobOf(text), size: text.length }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
  const trunk: LandingTestsTrunk = {
    landingNote: async (ref) => landings.get(ref) ?? null,
    commitOrder: async (shas) => Object.fromEntries(shas.flatMap((s) => (chain.includes(s) ? [[s, chain.indexOf(s)]] : []))),
    testLineage: async (q) => {
      calls.push("lineage");
      return Object.fromEntries(q.paths.map((p) => [p, opts.lineage?.[p] ?? { changes: [], more: false }]));
    },
    certifySnapshot: async () => {
      calls.push("snapshot");
      const head = chain[chain.length - 1]!;
      return { trunkSha: head, files: index(head), truncated: false };
    },
    baseBlobs: async (s, paths) => {
      calls.push(`baseBlobs ${chain.indexOf(s)}`);
      const tree = trees.get(s) ?? {};
      return paths.map((path) => ({ path, blob: path in tree ? blobOf(tree[path]!) : null }));
    },
    readBlobs: async (ids) => {
      calls.push("readBlobs");
      return Object.fromEntries(ids.map((b) => [b, blobs.get(b) ?? null]));
    },
  };

  /** A landing that made commit `s` on its parent, writing `wrote`; `note` overrides its lineage note. */
  const land = (id: string, s: Sha, wrote: Path[], note?: Partial<LineageNote> | null, intents: string[] = [`int_${id}`]): Landing => {
    const i = chain.indexOf(s);
    const landing: Landing = { id, colonyId: "col", trunkSha: s, parentSha: chain[i - 1]!, proposalIds: [`prp_${id}`], intentIds: intents, paths: wrote, regions: ["src"], at: i };
    const tree = trees.get(s)!;
    const gate = { name: "gate", ok: true, ms: 0, detail: "D3 innate+proof → land by deterministic at head 9a7220a8f2f2 (confirmations: innate + deterministic): proven" };
    const full: LineageNote = {
      schema: "firetrident.lineage/v1",
      landingId: id,
      colonyId: "col",
      proposals: [
        {
          id: `prp_${id}`,
          agentId: "agt_1",
          agentKind: "internal",
          model: GEMMA,
          intent: { id: intents[0]!, title: "t", why: "w" },
          writeSet: wrote.map((path) => ({ path, blob: path in tree ? blobOf(tree[path]!) : null })),
          readSet: [],
          decisions: [],
          evidence: { checks: [gate] },
        },
      ],
      ...(note ?? {}),
    };
    landings.set(id, { landing, note: note === null ? null : full });
    return landing;
  };

  /** Certification's result for commit `s`: its counts, and each test file's results stored under its key unless `forget` names it. */
  const certify = async (s: Sha, status: Certification["status"], outcomes: Outcomes, extra: { forget?: Path[]; detail?: string } = {}): Promise<void> => {
    const loaded = await load(index(s), async (ids) => Object.fromEntries(ids.map((b) => [b, blobs.get(b) ?? null])), DEFAULT_CAPS);
    const keys = await fileKeys(loaded, TIMEOUT);
    const counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0, suites: 0 };
    const failing: Certification["failing"] = [];
    for (const [file, tests] of Object.entries(outcomes)) {
      for (const [name, st] of tests) {
        counts.tests++;
        if (st === "pass") counts.pass++;
        else if (st === "fail") (counts.fail++, failing.push({ name, file }));
        else if (st === "skipped") counts.skipped++;
      }
      const key = keys.get(file);
      if (key && !extra.forget?.includes(file)) {
        const r = { path: file, loadError: null, tests: tests.map(([name, st]) => ({ name, file, status: st })), suites: [] };
        db.prepare("INSERT OR REPLACE INTO certify_files (key, path, at, data) VALUES (?, ?, ?, ?)").all(key, file, clock, JSON.stringify(r));
      }
    }
    const cert: Certification = { trunkSha: s, status, startedAt: ++clock, finishedAt: ++clock, ...(status === "skipped" ? {} : { counts, failing }), ...(extra.detail ? { detail: extra.detail } : {}) };
    db.prepare("INSERT OR REPLACE INTO certifications (trunk_sha, landing_id, status, started_at, finished_at, data) VALUES (?, ?, ?, ?, ?, ?)").all(s, null, status, cert.startedAt, cert.finishedAt!, JSON.stringify(cert));
  };

  const host: LandingTestsHost = {
    sql,
    colonyId: () => "col",
    trunk: () => trunk,
    memo: () => undefined,
    testTimeoutMs: () => TIMEOUT,
    off: () => opts.off ?? null,
    spend: opts.spend ?? (() => null),
  };
  return { reader: new LandingTestsReader(host), commit, land, certify, calls, db, trunk };
}

/** c0 the import, c1 a landing that changes src/math.js, c2 one that adds src/new.js with its own test. */
async function threeCommits(opts: Parameters<typeof world>[0] = {}, certified: { c0?: boolean; c1?: boolean; c2?: boolean } = {}) {
  const w = world(opts);
  const base: Tree = { "src/math.js": MATH, "test/math.test.js": MATH_TEST, "test/other.test.js": OTHER_TEST, "README.md": "# x\n" };
  const c0 = w.commit("c0", base);
  const c1 = w.commit("c1", { ...base, "src/math.js": MATH2 });
  const c2 = w.commit("c2", { ...base, "src/math.js": MATH2, "src/new.js": NEW, "test/new.test.js": NEW_TEST });
  w.land("lnd_1", c1, ["src/math.js"]);
  w.land("lnd_2", c2, ["src/new.js", "test/new.test.js"]);
  const atC0: Outcomes = { "test/math.test.js": [["adds", "pass"], ["subtracts", "pass"], ["flaky", "fail"]], "test/other.test.js": [["other", "pass"]] };
  const atC1: Outcomes = { "test/math.test.js": [["adds", "pass"], ["flaky", "pass"]], "test/other.test.js": [["other", "pass"]] };
  const atC2: Outcomes = { ...atC1, "test/new.test.js": [["fresh", "pass"]] };
  if (certified.c0 !== false) await w.certify(c0, "red", atC0);
  if (certified.c1 !== false) await w.certify(c1, "green", atC1);
  if (certified.c2 !== false) await w.certify(c2, "green", atC2);
  return { ...w, c0, c1, c2 };
}

describe("a landing's test row", () => {
  it("reads base against the certified commit: passing, lost and new tests, and an earlier test that reaches it", async () => {
    const { reader, c0, c1 } = await threeCommits({ spend: () => ({ usd: 0.0003, calls: 2, intents: 1 }) });
    const t = await reader.read("lnd_1");
    expect(t).toMatchObject({
      status: "certified",
      base: { sha: c0, status: "red", pass: 3, tests: 4, failing: 1, exact: true },
      certified: { sha: c1, status: "green", pass: 3, tests: 3, failing: 0 },
      lost: 1,
      lostTests: [{ file: "test/math.test.js", name: "subtracts" }],
      added: 1,
      reach: { earlier: 1, own: 0, later: 0, earlierFiles: ["test/math.test.js"], checked: 2 },
    });
    expect(t!.text).toBe("3/4 at base, 3/3 certified, 1 lost, 1 new · proof: deterministic · $0.0003 (model calls this platform made)");
  });

  it("finds no loss when only a new test file came, and warns when no earlier test reaches the change", async () => {
    const { reader, c1, c2 } = await threeCommits();
    const t = await reader.read("lnd_2");
    expect(t).toMatchObject({ status: "certified", base: { sha: c1, exact: true, pass: 3, tests: 3 }, certified: { sha: c2, pass: 4, tests: 4 }, lost: 0, added: 1 });
    expect(t!.reach).toEqual({ earlier: 0, own: 1, later: 0, earlierFiles: [], ownFiles: ["test/new.test.js"], checked: 3 });
    expect(t!.text).toBe("3/3 at base, 4/4 certified, 0 lost, 1 new · proof: deterministic");
  });

  it("names the nearest earlier result when the base was not certified", async () => {
    const { reader, c0 } = await threeCommits({}, { c1: false });
    const t = await reader.read("lnd_2");
    expect(t!.base).toMatchObject({ sha: c0, exact: false, pass: 3, tests: 4 });
    expect(t!.text).toBe(`3/4 at ${c0.slice(0, 7)}, before base, 4/4 certified, 1 lost, 2 new · proof: deterministic`);
  });

  it("says not certified yet, and why: no run yet, certification off, or trunk red", async () => {
    const none = await threeCommits({}, { c1: false, c2: false });
    expect((await none.reader.read("lnd_2"))!.text).toBe("not certified yet: no certification has run on a commit that includes it yet · proof: deterministic");
    const off = await threeCommits({ off: "trunk certification is off for this colony" }, { c1: false, c2: false });
    expect((await off.reader.read("lnd_1"))!).toMatchObject({ status: "pending", reason: "trunk certification is off for this colony", base: { exact: true } });
    const red = await threeCommits({}, { c2: false });
    await red.certify(red.c2, "red", { "test/math.test.js": [["adds", "fail"]] });
    const t = await red.reader.read("lnd_2");
    expect(t).toMatchObject({ status: "pending", red: { sha: red.c2, failing: 1, tests: 1 } });
    expect(t!.text).toBe(`not certified yet: trunk is red at ${red.c2.slice(0, 7)} (1 of 1 failing) · proof: deterministic`);
  });

  it("says when the colony has no test this platform can run", async () => {
    const w = world();
    const c0 = w.commit("h0", { "src/a.ts": "export const a = 1;\n", "test/a.test.ts": 'import { it } from "vitest";\nit("a", () => {});\n' });
    const c1 = w.commit("h1", { "src/a.ts": "export const a = 2;\n", "test/a.test.ts": 'import { it } from "vitest";\nit("a", () => {});\n' });
    w.land("lnd_h", c1, ["src/a.ts"]);
    await w.certify(c0, "skipped", {}, { detail: "no test file imports node:test (1 test file)" });
    // No run follows one with nothing to run, unless a test file comes: the result before it answers.
    const t = await w.reader.read("lnd_h");
    expect(t).toMatchObject({ status: "no-tests", reason: "no test file imports node:test (1 test file)" });
    expect(t!.text).toBe("no tests this platform can run · proof: deterministic");
    await w.certify(c1, "skipped", {}, { detail: "no test file imports node:test (1 test file)" });
    expect((await w.reader.read("lnd_h"))!.status).toBe("no-tests");
  });

  it("splits the tests by whose they are", async () => {
    const lineage: Record<Path, TestFileLineage> = {
      "test/math.test.js": { changes: [], more: false },
      "test/other.test.js": { changes: [{ landingId: "lnd_0", by: "person", name: "Lee" }], more: false },
      "test/new.test.js": { changes: [{ landingId: "lnd_2", by: "agent", name: GEMMA, added: true }], more: false },
    };
    const { reader } = await threeCommits({ lineage });
    const t = await reader.read("lnd_2");
    expect(t!.authors).toEqual({ inherited: { files: 1, tests: 2 }, agents: { files: 1, tests: 1, by: [GEMMA] }, person: { files: 1, tests: 1, by: ["Lee"] } });
  });

  it("counts files whose results are no longer kept as not compared", async () => {
    const w = await threeCommits({}, { c0: false });
    await w.certify(w.c0, "red", { "test/math.test.js": [["adds", "pass"], ["subtracts", "pass"]], "test/other.test.js": [["other", "pass"]] }, { forget: ["test/math.test.js"] });
    const t = await w.reader.read("lnd_1");
    expect(t).toMatchObject({ lost: 0, unknownFiles: 1 });
    expect(t!.text).toBe("3/3 at base, 3/3 certified, 0 lost (1 test file not compared) · proof: deterministic");
    expect(t!.detail).toMatch(/^1 test file could not be compared/);
  });

  it("caches the part that reads trees per landing and certified commit", async () => {
    const w = await threeCommits();
    const first = await w.reader.read("lnd_1");
    const reads = w.calls.length;
    expect(reads).toBeGreaterThan(0);
    expect(await w.reader.read("lnd_1")).toEqual(first);
    expect(w.calls.length).toBe(reads);
    const rows = w.db.prepare("SELECT landing_id, certified FROM landing_tests").all() as Array<{ landing_id: string; certified: string }>;
    expect(rows).toEqual([{ landing_id: "lnd_1", certified: expect.stringMatching(new RegExp(`^${TESTS_VERSION}:${w.c1}:`)) }]);
    // A result recorded again for the certified commit (a forced run) is read afresh.
    await w.certify(w.c1, "green", { "test/math.test.js": [["adds", "pass"], ["flaky", "pass"]], "test/other.test.js": [["other", "pass"]] });
    await w.reader.read("lnd_1");
    expect(w.calls.length).toBeGreaterThan(reads);
  });

  it("waits, saying so, while the trunk writer cannot place commits (older code for a moment after a deployment)", async () => {
    const w = await threeCommits();
    w.trunk.commitOrder = async () => {
      throw new Error("The RPC receiver does not implement the method \"commitOrder\".");
    };
    const t = await w.reader.read("lnd_1");
    expect(t).toMatchObject({ status: "pending" });
    expect(t!.text).toBe("not certified yet: the trunk writer could not place its commit just now (The RPC receiver does not implement the method \"commitOrder\"); ask again in a moment · proof: deterministic");
  });

  it("says what it could not read, and does not keep that row", async () => {
    const w = await threeCommits();
    const real = w.trunk.testLineage;
    w.trunk.testLineage = async () => {
      throw new Error("landing log busy");
    };
    const t = await w.reader.read("lnd_1");
    expect(t).toMatchObject({ status: "certified", lost: 1, detail: "Whose tests they are could not be read from the landing log: landing log busy." });
    expect(t!.authors).toBeUndefined();
    w.trunk.testLineage = real;
    expect((await w.reader.read("lnd_1"))!.authors).toMatchObject({ inherited: { files: 2 } });
  });

  it("answers null for a landing the trunk writer does not know", async () => {
    const { reader } = await threeCommits();
    expect(await reader.read("lnd_nope")).toBeNull();
  });
});

describe("the row's parts", () => {
  it("places a landing among results by commit, not by time", () => {
    const r = (s: string, status: string, seq: number, startedAt = seq) => ({ sha: s, status, seq, startedAt, finishedAt: startedAt });
    const at = placeLanding([r("g9", "green", 9, 1), r("r5", "red", 5, 50), r("g7", "green", 7, 70), r("g2", "green", 2), r("s3", "skipped", 3)], 5, 4);
    expect(at.certified?.sha).toBe("g7");
    expect(at.red?.sha).toBe("r5");
    expect(at.base?.sha).toBe("g2");
    expect(at.before?.sha).toBe("s3");
  });

  it("reads a test file's origin from its changes", () => {
    expect(originOf({ changes: [], more: false })).toBe("inherited");
    expect(originOf({ changes: [{ landingId: "a", by: "person" }, { landingId: "b", by: "agent" }], more: false })).toBe("agents");
    expect(originOf({ changes: [{ landingId: "a", by: "person" }], more: false })).toBe("person");
    expect(originOf({ changes: [{ landingId: "a", by: "person" }], more: true })).toBe("unknown");
    expect(originOf({ changes: [{ landingId: "a", by: "system" }], more: false })).toBe("unknown");
    expect(originOf(undefined)).toBe("unknown");
    const a = authorsOf(["x.test.js", "y.test.js"], { "x.test.js": { changes: [], more: false } }, new Map([["x.test.js", 3]]));
    expect(a).toEqual({ inherited: { files: 1, tests: 3 }, agents: { files: 0, tests: 0 }, person: { files: 0, tests: 0 }, unknown: { files: 1, tests: 0 }, uncounted: 1 });
  });

  it("says why certification does not run, and adds up the spend of the landing's intents", () => {
    expect(certificationOff({ deployment: false, runner: true, policy: { enabled: true } })).toBe("trunk certification is off on this deployment");
    expect(certificationOff({ deployment: true, runner: true, policy: { enabled: false } })).toBe("trunk certification is off for this colony");
    expect(certificationOff({ deployment: true, runner: false, policy: { enabled: true } })).toBe("this deployment has no test runner");
    expect(certificationOff({ deployment: true, runner: true, policy: { enabled: true } })).toBeNull();
    const spent = (id: string) => (id === "int_none" ? intentSpend(id, []) : intentSpend(id, [{ layer: "agents", model: GEMMA, calls: 2, input: 1_000, output: 200 }]));
    const both = landingSpend(["int_a", "int_b", "int_none"], spent);
    expect(both).toMatchObject({ calls: 4, intents: 2 });
    expect(both!.usd).toBeCloseTo(2 * spent("int_a").usd, 10);
    expect(landingSpend(["int_none"], spent)).toBeNull();
  });

  it("bounds the closure check and looks only for code a test can load", async () => {
    const w = writtenCode({ paths: ["README.md"] }, null);
    expect(w.paths.size).toBe(0);
    const many = writtenCode({ paths: Array.from({ length: 70 }, (_, i) => `src/f${i}.ts`) }, null);
    expect([many.paths.size, many.more]).toEqual([64, true]);
    const tree: Tree = { "src/math.js": MATH, "test/math.test.js": MATH_TEST, "test/other.test.js": OTHER_TEST };
    const loaded = await load(
      Object.entries(tree).map(([path, text]) => ({ path, blob: blobOf(text), size: text.length })),
      async (ids) => Object.fromEntries(ids.map((b) => [b, Object.values(tree).find((t) => blobOf(t) === b) ?? null])),
    );
    expect(reachingFiles(loaded, new Set(["src/math.js"]))).toEqual({ own: [], others: ["test/math.test.js"], checked: 2 });
    expect(reachingFiles(loaded, new Set(["test/other.test.js"]))).toEqual({ own: ["test/other.test.js"], others: [], checked: 2 });
    expect(reachingFiles({ ...loaded, truncated: true }, new Set(["src/none.js"]))).toEqual({ own: [], others: [], checked: 2, bounded: "the tree was read only up to certification's read caps" });
  });
});
